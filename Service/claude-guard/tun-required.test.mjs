import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { validateConfig, CLAUDE_DOMAINS, GOOGLE_AUTH_HOSTS } from './config.mjs'
import { createGuard, verifyPolicy } from './guard.mjs'
import { createController } from './controller.mjs'
import { createGateway } from './gateway.mjs'
import { connectTunnel } from './tunnel.mjs'
import { tunRequiredRules, closeClaudeConnections } from './tun-connections.mjs'
import { applyClaudeGuard } from './profile.mjs'
import { composeOwnedScript } from './owned.mjs'
import { Script } from 'node:vm'

const c = validateConfig({ requireTun: true, expectedIP: '203.0.113.20', proxyPassword: 'a'.repeat(64) })
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } }
function fixture({ gateway: supplied, probe: suppliedProbe } = {}) {
  const data = {
    '/configs': { mode: 'rule', tun: { enable: true } },
    '/proxies': { proxies: { [c.policyGroup]: { type: 'Selector', all: ['REJECT', c.gatewayProxy], now: 'REJECT' }, [c.gatewayProxy]: { type: 'Http', udp: false } } },
    '/rules': { rules: [
      ...CLAUDE_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload, proxy: c.policyGroup })),
      ...GOOGLE_AUTH_HOSTS.map(payload => ({ type: 'Domain', payload, proxy: c.policyGroup })),
      ...tunRequiredRules(c).map(r => { const [type, payload, proxy] = r.split(','); return { type: type === 'DOMAIN' ? 'Domain' : 'DomainSuffix', payload, proxy } }),
    ] },
  }
  let open = false, expiresAt = 0, probes = 0, drains = 0
  const order = []
  const gateway = supplied || { status: () => ({ open, expiresAt }), grant: until => { open = true; expiresAt = until; order.push('open') }, closeAll: () => { open = false; expiresAt = 0; order.push('close') } }
  const controller = { request: async path => structuredClone(data[path]), select: async name => { order.push(name); data['/proxies'].proxies[c.policyGroup].now = name } }
  const guard = createGuard(c, controller, gateway, async () => { probes++; return suppliedProbe ? suppliedProbe() : { ip: c.expectedIP } }, { drain: async () => { drains++; order.push('drain') } })
  return { guard, data, controller, gateway, order, get probes() { return probes }, get drains() { return drains } }
}
test('TUN off or absent never probes or opens, even with correct target configured', async () => {
  for (const tun of [{ enable: false }, {}, undefined]) {
    const f = fixture(); f.data['/configs'].tun = tun
    await f.guard.enable(); await f.guard.inspect()
    assert.equal(f.guard.status().reason, 'tun-required')
    assert.equal(f.guard.status().tunEnabled, false)
    assert.equal(f.probes, 0); assert.equal(f.gateway.status().open, false)
    assert.ok(!f.order.includes(c.gatewayProxy)); await f.guard.dispose()
  }
  assert.throws(() => validateConfig({ requireTun: 'true' }), /TUN/)
})
test('turning TUN off closes before controller writes, resets recovery and drains Claude connections', async () => {
  const f = fixture(); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  assert.equal(f.gateway.status().open, true)
  f.order.length = 0; f.data['/configs'].tun.enable = false
  assert.equal(await f.guard.checkTun(), false)
  assert.deepEqual(f.order, ['close', 'REJECT', 'drain'])
  assert.equal(f.guard.status().successes, 0)
  f.data['/configs'].tun.enable = true
  await f.guard.checkTun(); assert.equal(f.gateway.status().open, false)
  for (let i = 1; i <= 3; i++) { await f.guard.inspect(); assert.equal(f.gateway.status().open, i === 3) }
  assert.equal(f.guard.status().manual, false); await f.guard.dispose()
})
test('TUN off invalidates an in-flight successful probe', async () => {
  const wait = defer(), entered = defer()
  const f = fixture({ probe: async () => { entered.resolve(); return wait.promise } })
  const enabling = f.guard.enable(); await entered.promise
  f.data['/configs'].tun.enable = false; await f.guard.checkTun()
  wait.resolve({ ip: c.expectedIP }); await enabling
  assert.equal(f.guard.status().reason, 'tun-required')
  assert.equal(f.gateway.status().open, false); assert.equal(f.guard.status().successes, 0)
  await f.guard.dispose()
})
test('TUN change while selector is pending cannot grant a late lease', async () => {
  const f = fixture(); await f.guard.enable(); await f.guard.inspect()
  const pending = defer(), entered = defer(), select = f.controller.select
  f.controller.select = async name => { if (name === c.gatewayProxy) { entered.resolve(); await pending.promise } return select(name) }
  const checking = f.guard.inspect(); await entered.promise
  f.data['/configs'].tun.enable = false; await f.guard.checkTun(); pending.resolve(); await checking
  assert.equal(f.gateway.status().open, false); assert.ok(!f.order.includes('open'))
  await f.guard.checkTun(); assert.equal(f.data['/proxies'].proxies[c.policyGroup].now, 'REJECT')
  await f.guard.dispose()
})
test('cannot confirm TUN: close existing lease and report blocked', async () => {
  const f = fixture(); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  f.controller.request = async () => { throw new Error('offline') }
  assert.equal(await f.guard.checkTun(), false)
  assert.equal(f.gateway.status().open, false); assert.equal(f.guard.status().reason, 'tun-status-unavailable')
  assert.equal(f.guard.status().tunEnabled, null); await f.guard.dispose()
})
test('removing additional Claude login rules prevents granting even with TUN on', async () => {
  const f = fixture(); f.data['/rules'].rules.pop()
  await f.guard.enable(); assert.equal(f.guard.status().reason, 'coverage-rules-changed')
  assert.equal(f.probes, 0); assert.equal(f.gateway.status().open, false); await f.guard.dispose()
})
test('fast TUN polling cuts a real established tunnel while an exit probe remains pending', async t => {
  const upstream = http.createServer()
  upstream.on('connect', (_req, socket) => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); socket.on('data', x => socket.write(x)); socket.on('error', () => {}); socket.on('end', () => socket.end()) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const gateway = createGateway({ ...c, gatewayPort: 0, probePort: upstream.address().port }); await gateway.start()
  const pending = defer(), entered = defer()
  let stall = false
  const f = fixture({ gateway, probe: () => { if (stall) { entered.resolve(); return pending.promise } return { ip: c.expectedIP } } })
  t.after(async () => { pending.resolve({ ip: c.expectedIP }); await f.guard.dispose(); await gateway.stop(); await new Promise(r => upstream.close(r)) })
  await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  const socket = await connectTunnel(c, 'claude.ai:443', gateway.address().port); socket.resume()
  const closed = once(socket, 'close')
  stall = true; f.guard.start(); await entered.promise
  const started = Date.now(); f.data['/configs'].tun.enable = false
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('TUN-off did not cut tunnel')), 1200).unref())])
  assert.ok(Date.now() - started < 1000)
  assert.equal(gateway.status().open, false); assert.equal(f.guard.status().reason, 'tun-required')
  pending.resolve({ ip: c.expectedIP })
})
test('connection drain keeps Codex and ordinary traffic, cuts Claude processes, gateway and login hosts', async () => {
  const rows = [
    { id: 'claude-host', metadata: { host: 'api.claude.ai' } },
    { id: 'renderer', metadata: { process: 'Claude Helper (Renderer)', host: 'shared.sentry.io' } },
    { id: 'code', metadata: { processPath: '/Users/example/.local/share/claude/versions/2.0.0' } },
    { id: 'gateway', chains: [c.gatewayProxy], metadata: { host: 'unknown.example' } },
    { id: 'auth0', metadata: { host: 'anthropic.auth0.com' } },
    { id: 'codex', chains: ['Codex-Intranet'], metadata: { process: 'Orca', host: 'chatgpt.com' } },
    { id: 'ordinary', metadata: { process: 'Orca', host: 'unrelated.sentry.io' } },
  ]
  const removed = []
  const controller = { request: async (path, method) => { if (path === '/connections') return { connections: rows }; assert.equal(method, 'DELETE'); removed.push(path.split('/').at(-1)) } }
  assert.equal(await closeClaudeConnections(c, controller), 5)
  assert.deepEqual(removed.sort(), ['auth0', 'claude-host', 'code', 'gateway', 'renderer'])
})
test('short controller deadline works independently of ordinary probe timeout', async t => {
  const server = http.createServer(() => {})
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const controller = createController({ ...c, controllerURL: 'http://127.0.0.1:' + server.address().port, timeoutMs: 10000 })
  const start = Date.now(); await assert.rejects(controller.request('/configs', 'GET', undefined, { timeoutMs: 100 }), /timeout/)
  assert.ok(Date.now() - start < 1000)
})
test('persistent owned script keeps extra gate rules before public TUN catch-all and preserves Codex', () => {
  const owned = { ...c, selectedProxy: 'fixed', ownedProtection: true, coverageVersion: 1, publicTunExit: true }
  const input = { proxies: [{ name: 'fixed', type: 'socks5', server: 'example.com', port: 1234, udp: false }], 'proxy-groups': [], rules: ['MATCH,DIRECT'], tun: { enable: false } }
  const intranet = { interfaceName: 'utun0', dnsServer: '10.50.0.53', excludedNetworks: ['100.64.0.0/10'] }
  const result = new Script(composeOwnedScript('function main(c) { return c }', owned, intranet) + '\nmain(input)').runInNewContext({ input })
  const end = result.rules.indexOf(`IN-TYPE,TUN,${c.pinnedProxy}`)
  for (const rule of tunRequiredRules(owned)) assert.ok(result.rules.indexOf(rule) >= 0 && result.rules.indexOf(rule) < end)
  assert.ok(result.rules.indexOf('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet') < end)
  assert.equal(result.tun.enable, false)
  const guarded = applyClaudeGuard(result, owned)
  assert.deepEqual([...guarded.rules.slice(0, 7)], [...result.rules.slice(0, 7)])
})
test('Google exception changes prefix positions without weakening mandatory TUN or Claude verification', async () => {
  const cfg = validateConfig({ ...c, guardGoogleAuth: false })
  const f = fixture(); f.data['/rules'].rules.splice(4, 3)
  assert.equal(verifyPolicy({ configs: f.data['/configs'], proxies: f.data['/proxies'], rules: f.data['/rules'] }, cfg), true)
  f.data['/configs'].tun.enable = false
  const guard = createGuard(cfg, f.controller, f.gateway, async () => { throw Error('must not probe while TUN is off') })
  await guard.enable(); assert.equal(guard.status().reason, 'tun-required'); assert.equal(f.gateway.status().open, false)
  await guard.dispose(); await f.guard.dispose()
  const owned = { ...cfg, selectedProxy: 'fixed', ownedProtection: true, coverageVersion: 1, publicTunExit: true }
  const input = { proxies: [{ name: 'fixed', type: 'socks5', server: 'example.com', port: 1234, udp: false }], 'proxy-groups': [], rules: ['DOMAIN-SUFFIX,google.com,ordinary', 'MATCH,DIRECT'], tun: { enable: false } }
  const result = new Script(composeOwnedScript('function main(c){return c}', owned) + '\nmain(input)').runInNewContext({ input })
  const end = result.rules.indexOf('IN-TYPE,TUN,' + cfg.pinnedProxy)
  for (const rule of tunRequiredRules(cfg)) assert.ok(result.rules.indexOf(rule) >= 0 && result.rules.indexOf(rule) < end)
  assert.ok(!result.rules.includes('DOMAIN,www.google.com,' + cfg.policyGroup))
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,google.com,ordinary'))
})
test('admission uses the existing lease without probing, renewing it or waiting for a pending exit sample', async () => {
  let stall = false
  const wait = defer(), entered = defer()
  const f = fixture({ probe: async () => { if (stall) { entered.resolve(); return wait.promise } return { ip: c.expectedIP } } })
  await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  const expiresAt = f.gateway.status().expiresAt, samples = f.guard.status().samples.length
  stall = true; const checking = f.guard.inspect(); await entered.promise
  assert.ok((await Promise.all(Array.from({ length: 20 }, () => f.guard.admit()))).every(Boolean))
  assert.equal(f.probes, 4); assert.equal(f.gateway.status().expiresAt, expiresAt)
  assert.equal(f.guard.status().samples.length, samples)
  wait.resolve({ ip: c.expectedIP }); await checking
  await f.guard.dispose()
})
test('admission rejects closed, manual, wrong-IP, TUN-off, tampered-rule and unavailable-controller states', async () => {
  for (const mutate of [
    async f => f.gateway.closeAll(), async f => f.guard.block(),
    async f => { f.data['/configs'].tun.enable = false },
    async f => { f.data['/rules'].rules[0].proxy = 'DIRECT' },
    async f => { f.controller.request = async () => { throw Error('offline') } },
  ]) {
    const f = fixture(); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
    await mutate(f); assert.equal(await f.guard.admit(), false); assert.equal(f.gateway.status().open, false)
    await f.guard.dispose()
  }
  let ip = c.expectedIP
  const f = fixture({ probe: () => ({ ip }) }); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  ip = '203.0.113.11'; await f.guard.inspect(); assert.equal(await f.guard.admit(), false)
  assert.equal(f.guard.status().reason, 'exit-ip-mismatch'); await f.guard.dispose()
})
test('a rule failure at admission invalidates an older good probe before it can renew the lease', async () => {
  let stall = false
  const wait = defer(), entered = defer()
  const f = fixture({ probe: async () => { if (stall) { entered.resolve(); return wait.promise } return { ip: c.expectedIP } } })
  await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  stall = true; const checking = f.guard.inspect(); await entered.promise
  f.data['/rules'].rules[0].proxy = 'DIRECT'
  assert.equal(await f.guard.admit(), false)
  wait.resolve({ ip: c.expectedIP }); await checking
  assert.equal(f.gateway.status().open, false); assert.equal(f.guard.status().reason, 'protected-rules-changed')
  await f.guard.dispose()
})
test('manual block during a pending admission cannot be undone by the controller reply', async () => {
  const f = fixture(); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  const wait = defer(), entered = defer(), request = f.controller.request
  f.controller.request = async (...args) => { if (args[0] === '/rules') { entered.resolve(); await wait.promise } return request(...args) }
  const admitting = f.guard.admit(); await entered.promise
  await f.guard.block(); wait.resolve(); assert.equal(await admitting, false)
  assert.equal(f.gateway.status().open, false); await f.guard.dispose()
})
