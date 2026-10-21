import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, CLAUDE_DOMAINS, GOOGLE_AUTH_HOSTS } from './config.mjs'
import { createGuard } from './guard.mjs'
import { validateProbeChain } from './probe.mjs'
const c = validateConfig({ proxyPassword: 'a'.repeat(64) })
function fixture() {
  const writes = [], order = []
  const data = { '/configs': { mode: 'rule' }, '/proxies': { proxies: {
    [c.policyGroup]: { type: 'Selector', all: ['REJECT', c.gatewayProxy], now: 'REJECT' },
    [c.gatewayProxy]: { type: 'Http', udp: false },
  } }, '/rules': { rules: CLAUDE_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload, proxy: c.policyGroup }))
    .concat(GOOGLE_AUTH_HOSTS.map(payload => ({ type: 'Domain', payload, proxy: c.policyGroup }))) } }
  const controller = { request: async path => structuredClone(data[path]), select: async name => { writes.push(name); order.push(name) } }
  let open = false
  const gateway = { status: () => ({ open, expiresAt: open ? Date.now() + 1000 : 0 }),
    grant: () => { open = true; order.push('open') }, closeAll: () => { open = false; order.push('close') } }
  let sample = { ip: c.expectedIP }, fail = false
  const probe = async () => { if (fail) throw new Error('secret should not be logged'); return sample }
  const guard = createGuard(c, controller, gateway, probe)
  return { guard, controller, gateway, writes, order, data, setSample: x => sample = x, fail: () => fail = true }
}
test('observation never writes controller and never opens gateway', async () => {
  const f = fixture(); await f.guard.inspect()
  assert.equal(f.guard.status().state, 'observe'); assert.equal(f.writes.length, 0); assert.equal(f.gateway.status().open, false)
  await f.guard.dispose()
})
test('requires consecutive good samples; wrong IP closes established gate before REJECT', async () => {
  const f = fixture(); await f.guard.enable(); await f.guard.inspect()
  assert.equal(f.gateway.status().open, false)
  await f.guard.inspect(); assert.equal(f.guard.status().state, 'protected')
  f.setSample({ ip: '203.0.113.11' }); f.order.length = 0; await f.guard.inspect()
  assert.equal(f.guard.status().reason, 'exit-ip-mismatch'); assert.deepEqual(f.order, ['close', 'REJECT'])
  await f.guard.dispose()
})
test('mode, policy and rule changes, timeout/controller loss close gateway', async () => {
  for (const mutate of [f => f.data['/configs'].mode = 'direct', f => f.data['/proxies'].proxies[c.policyGroup].all.push('DIRECT'),
    f => f.data['/rules'].rules[0].proxy = 'DIRECT', f => f.fail(),
    f => f.controller.request = async () => { throw new Error('unavailable') }]) {
    const f = fixture(); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
    mutate(f); await f.guard.inspect(); assert.equal(f.gateway.status().open, false); assert.equal(f.guard.status().state, 'blocked')
    await f.guard.dispose()
  }
})
test('manual block persists through healthy samples and in-flight probe completion', async () => {
  const f = fixture(); await f.guard.enable(); await f.guard.inspect(); await f.guard.inspect()
  await f.guard.block(); for (let i = 0; i < 4; i++) await f.guard.inspect()
  assert.equal(f.gateway.status().open, false); assert.equal(f.guard.status().manual, true)
  let release
  const promise = new Promise(resolve => release = resolve)
  const guard = createGuard(c, f.controller, f.gateway, () => promise)
  const enabling = guard.enable()
  await new Promise(resolve => setImmediate(resolve))
  const blocking = guard.block(); release({ ip: c.expectedIP }); await Promise.all([enabling, blocking])
  assert.equal(guard.status().manual, true); assert.equal(f.gateway.status().open, false)
  await f.guard.dispose(); await guard.dispose()
})
test('probe route requires matching source port, inbound and pinned chain', () => {
  const conn = { connections: [{ metadata: { sourcePort: 40000, inboundPort: c.probePort, host: 'claude.ai' }, chains: [c.pinnedProxy, c.pinnedEntry] }] }
  assert.deepEqual(validateProbeChain(conn, c, 40000, c.probePort), [c.pinnedProxy, c.pinnedEntry])
  assert.throws(() => validateProbeChain(conn, c, 40001, c.probePort))
  conn.connections[0].chains = [c.pinnedProxy, 'other-exit']
  assert.throws(() => validateProbeChain(conn, c, 40000, c.probePort))
})
