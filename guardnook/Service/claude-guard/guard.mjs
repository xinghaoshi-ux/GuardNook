import { CLAUDE_DOMAINS, GOOGLE_AUTH_HOSTS } from './config.mjs'
import { coverageRules } from './coverage.mjs'
import { tunRequiredRules } from './tun-connections.mjs'

export function verifyPolicy(snapshot, c) {
  const { configs, proxies, rules } = snapshot
  const group = proxies.proxies?.[c.policyGroup]
  const gateway = proxies.proxies?.[c.gatewayProxy]
  if (configs.mode !== 'rule') throw new Error('rule-mode-required')
  if (c.selectedProxy) {
    const pinned = proxies.proxies?.[c.pinnedProxy]
    if (pinned?.type !== 'Selector' || pinned.udp !== false || pinned.all?.length !== 1
      || pinned.all[0] !== (c.frozenExitProxy || c.selectedProxy) || pinned.now !== (c.frozenExitProxy || c.selectedProxy))
      throw new Error('guard-route-not-installed')
  }
  if (c.frozenExitProxy) {
    const aliases = [c.frozenExitProxy, ...(c.upstreamChain || [])]
    for (const [index, name] of aliases.entries()) {
      const node = proxies.proxies?.[name]
      if (!node || ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Direct', 'Reject', 'Pass'].includes(node.type)
        || (node['dialer-proxy'] || '') !== (aliases[index + 1] || '')) throw new Error('frozen-chain-changed')
    }
  }
  if (!c.proxyPassword || group?.type !== 'Selector'
    || group.all?.length !== 2 || !group.all.includes('REJECT') || !group.all.includes(c.gatewayProxy)
    || !['REJECT', c.gatewayProxy].includes(group.now)
    || gateway?.type !== 'Http' || gateway.udp !== false) throw new Error('guard-route-not-installed')
  const expected = CLAUDE_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload }))
    .concat((c.guardGoogleAuth === false ? [] : GOOGLE_AUTH_HOSTS).map(payload => ({ type: 'Domain', payload })))
  for (const [i, rule] of expected.entries()) {
    const actual = rules.rules?.[i]
    if (actual?.type !== rule.type || actual.payload !== rule.payload || actual.proxy !== c.policyGroup)
      throw new Error('protected-rules-changed')
  }
  if (c.coverageVersion === 1) {
    const extra = coverageRules(c)
    for (const [offset, value] of extra.entries()) {
      const parts = value.split(',')
      const type = { 'DOMAIN-SUFFIX': 'DomainSuffix', DOMAIN: 'Domain', 'IP-CIDR': 'IPCIDR', 'IP-CIDR6': 'IPCIDR6', 'PROCESS-NAME': 'ProcessName', 'PROCESS-PATH-REGEX': 'ProcessPathRegex', 'IN-PORT': 'InPort', AND: 'AND' }[parts[0]]
      const policy = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1)
      const actual = rules.rules?.[expected.length + offset]
      // Normalize only the kernel's type names and logical separators. Compare
      // the full structure so a NOT predicate or altered subnet cannot pass.
      const payload = parts.slice(1, parts.at(-1) === 'no-resolve' ? -2 : -1).join(',')
      const normalized = String(actual?.payload)
        .replace(/DomainSuffix/g, 'DOMAIN-SUFFIX').replace(/ProcessPathRegex/g, 'PROCESS-PATH-REGEX')
        .replace(/ProcessName/g, 'PROCESS-NAME').replace(/Network/g, 'NETWORK')
        .replace(/\(NETWORK,(udp|tcp)\)/g, (_, protocol) => `(NETWORK,${protocol.toUpperCase()})`)
        .replace(/\s*(?:&&|\|\|)\s*/g, ',')
      const matchingType = actual?.type === type || type === 'IPCIDR6' && actual?.type === 'IPCIDR'
      if (!matchingType || actual.proxy !== policy || normalized !== payload) throw new Error('coverage-rules-changed')
    }
  }
  if (c.requireTun) {
    for (const [offset, value] of tunRequiredRules(c).entries()) {
      const [type, payload, proxy] = value.split(',')
      const actual = rules.rules?.[expected.length + coverageRules(c).length + offset]
      if (actual?.type !== (type === 'DOMAIN' ? 'Domain' : 'DomainSuffix') || actual.payload !== payload || actual.proxy !== proxy)
        throw new Error('coverage-rules-changed')
    }
  }
  return true
}

export function createGuard(c, controller, gateway, probe, { contain, drain } = {}) {
  let enabled = false, manual = false, disposed = false, generation = 0
  let pending, admissionPending, timer, tunTimer, tunPending, tunEnabled = null, successes = 0, prepared = false, last, reason = 'observation-only', state = 'observe'
  const events = []
  const samples = []
  const sample = value => { samples.unshift(value); if (samples.length > 60) samples.pop() }
  const record = event => { events.unshift(event); if (events.length > 40) events.pop() }
  const snapshot = () => {
    const gate = gateway.status()
    return { state: enabled && state === 'protected' && !gate.open ? 'blocked' : state,
      reason: enabled && state === 'protected' && !gate.open ? 'verification-expired' : reason,
      enabled, manual, prepared, requireTun: c.requireTun, tunEnabled, expectedIP: c.expectedIP, pinnedProxy: c.pinnedProxy, policyGroup: c.policyGroup, last: last || null,
      successes, recoverySamples: c.recoverySamples, leaseMs: c.leaseMs,
      intervalMs: c.intervalMs, timeoutMs: c.timeoutMs, gateway: gate, events: [...events], samples: [...samples] }
  }
  const rejectPolicy = async () => { try { await controller.select('REJECT') } catch { /* Gate is already closed. */ } }
  const fail = async why => {
    generation++
    gateway.closeAll(); successes = 0; state = 'blocked'; reason = why
    if (enabled) await rejectPolicy()
    if (enabled && contain && ['guard-route-not-installed', 'protected-rules-changed', 'coverage-rules-changed', 'frozen-chain-changed', 'rule-mode-required'].includes(why)) {
      try { await contain() } catch { /* The managed gate remains closed. */ }
    }
  }
  const blockForTun = async why => {
    const changed = reason !== why || gateway.status().open
    if (changed) generation++ // invalidate any older probe/selector completion
    gateway.closeAll(); successes = 0; state = 'blocked'; reason = why
    if (enabled) await rejectPolicy()
    if (changed && drain) { try { await drain() } catch { /* local gate stays closed */ } }
  }
  const checkTun = () => {
    if (!c.requireTun || disposed) return Promise.resolve(true)
    if (tunPending) return tunPending
    tunPending = (async () => {
      try {
        const config = await controller.request('/configs', 'GET', undefined, { timeoutMs: 700 })
        if (disposed) return false
        tunEnabled = config.tun?.enable === true
        if (!tunEnabled) { await blockForTun('tun-required'); return false }
        return true
      } catch {
        if (!disposed) { tunEnabled = null; await blockForTun('tun-status-unavailable') }
        return false
      }
    })().finally(() => { tunPending = undefined })
    return tunPending
  }
  const admissible = () => !disposed && enabled && !manual && prepared && state === 'protected'
    && last?.ip === c.expectedIP && gateway.status().open
  const admit = () => {
    if (!admissible()) return Promise.resolve(false)
    if (admissionPending) return admissionPending
    const epoch = generation
    admissionPending = (async () => {
      // A request may use only the existing short lease. This check never
      // renews it, counts recovery samples or waits for another Internet probe.
      try {
        const [configs, proxies, rules] = await Promise.all(['/configs', '/proxies', '/rules']
          .map(path => controller.request(path, 'GET', undefined, { timeoutMs: 700 })))
        if (generation !== epoch || !admissible()) return false
        if (c.requireTun) {
          tunEnabled = configs.tun?.enable === true
          if (!tunEnabled) { await blockForTun('tun-required'); return false }
        }
        try { verifyPolicy({ configs, proxies, rules }, c) }
        catch (error) { await fail(error.message); return false }
        return generation === epoch && admissible()
      } catch {
        if (generation === epoch && !disposed) await fail('probe-or-controller-unavailable')
        return false
      }
    })().finally(() => { admissionPending = undefined })
    return admissionPending
  }
  const inspect = () => {
    if (disposed) return Promise.resolve(snapshot())
    if (pending) return pending
    const epoch = generation
    pending = (async () => {
      const started = Date.now()
      try {
        const [configs, proxies, rules] = await Promise.all([
          controller.request('/configs'), controller.request('/proxies'), controller.request('/rules'),
        ])
        if (generation !== epoch || disposed) return snapshot()
        if (c.requireTun) {
          tunEnabled = configs.tun?.enable === true
          if (!tunEnabled) { await blockForTun('tun-required'); return snapshot() }
        }
        prepared = false
        try { verifyPolicy({ configs, proxies, rules }, c); prepared = true }
        catch (error) {
          if (enabled) { sample({ at: Date.now(), ok: false, reason: error.message, durationMs: Date.now() - started }); await fail(error.message); return snapshot() }
          if (c.selectedProxy) { gateway.closeAll(); state = 'observe'; reason = error.message; return snapshot() }
        }
        const sampledAt = Date.now()
        const result = await probe(c, controller, prepared ? c.probePort : c.clientPort)
        if (generation !== epoch || disposed) return snapshot()
        const verifiedAt = Date.now()
        last = { ...result, sampledAt, verifiedAt }
        sample({ at: verifiedAt, ok: result.ip === c.expectedIP, reason: result.ip === c.expectedIP ? 'verified' : 'exit-ip-mismatch',
          durationMs: verifiedAt - sampledAt, ip: result.ip })
        if (result.ip !== c.expectedIP) {
          if (enabled) await fail('exit-ip-mismatch')
          else { reason = 'exit-ip-mismatch'; state = 'observe' }
          return snapshot()
        }
        if (!enabled) { state = 'observe'; reason = prepared ? 'ready-not-enabled' : 'guard-route-not-installed'; return snapshot() }
        if (manual) { state = 'blocked'; reason = 'manual-block'; return snapshot() }
        if (Date.now() >= verifiedAt + c.leaseMs) { await fail('verification-expired'); return snapshot() }
        successes++
        if (successes < c.recoverySamples) { state = 'blocked'; reason = 'confirming-exit'; return snapshot() }
        if (!await checkTun() || generation !== epoch || disposed || manual) return snapshot()
        // Only this one selector is writable. Gate remains closed during recovery.
        await controller.select(c.gatewayProxy)
        if (generation !== epoch || disposed || manual) return snapshot()
        if (!await checkTun() || generation !== epoch || disposed || manual) return snapshot()
        // The attested TLS response confirms the exit at completion. Slow SOCKS
        // authentication before that response must not consume its fresh lease.
        const expiresAt = verifiedAt + c.leaseMs
        if (Date.now() >= expiresAt) { await fail('verification-expired'); return snapshot() }
        gateway.grant(expiresAt)
        state = 'protected'; reason = 'verified-pinned-exit'
      } catch {
        if (generation !== epoch || disposed) return snapshot()
        sample({ at: Date.now(), ok: false, reason: 'probe-or-controller-unavailable', durationMs: Date.now() - started })
        if (enabled) await fail('probe-or-controller-unavailable')
        else { gateway.closeAll(); state = 'observe'; reason = 'probe-or-controller-unavailable'; prepared = false }
      }
      return snapshot()
    })().finally(() => { pending = undefined })
    return pending
  }
  return {
    status: snapshot, record, inspect, checkTun, admit,
    start() {
      if (!timer) { void inspect(); timer = setInterval(() => void inspect(), c.intervalMs) }
      if (c.requireTun && !tunTimer) { void checkTun(); tunTimer = setInterval(() => void checkTun(), 250) }
    },
    async enable() {
      generation++; gateway.closeAll(); enabled = true; manual = false; successes = 0; state = 'blocked'; reason = 'confirming-exit'
      if (pending) await pending
      await rejectPolicy()
      return inspect()
    },
    async block() {
      generation++; gateway.closeAll(); enabled = true; manual = true; successes = 0; state = 'blocked'; reason = 'manual-block'
      // Wait out a previous select so a late success cannot undo this block.
      if (pending) await pending
      await rejectPolicy()
      return snapshot()
    },
    async dispose() {
      disposed = true; generation++; clearInterval(timer); clearInterval(tunTimer); gateway.closeAll()
      if (pending) await pending
      if (tunPending) await tunPending
      if (admissionPending) await admissionPending
      if (enabled) await rejectPolicy()
    },
  }
}
