import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, CLAUDE_DOMAINS } from './config.mjs'
import { reviewDomains, reviewDNS, safeResolver, reviewConnections, createDiagnostics } from './diagnostics.mjs'
import { identifyRoute, checkClientRoute, createRouteCheck, CHECK_HOSTS } from './route-check.mjs'
const c = { ...DEFAULT_CONFIG }

test('domain review honours priority and treats unresolved context as unknown', () => {
  const rules = CLAUDE_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload, proxy: c.policyGroup }))
  let rows = reviewDomains(rules, c)
  assert.equal(rows.find(row => row.host === 'api.anthropic.com').coverage, 'covered')
  assert.equal(rows.find(row => row.host === 'claudemcpclient.com').coverage, 'unknown')
  assert.equal(rows.find(row => row.host === 'github.com').category, 'shared')
  rows = reviewDomains([{ type: 'Domain', payload: 'api.anthropic.com', proxy: 'DIRECT' }, ...rules], c)
  assert.equal(rows.find(row => row.host === 'api.anthropic.com').coverage, 'other')
  rows = reviewDomains([{ type: 'RuleSet', payload: 'unknown-list', proxy: 'DIRECT' }, ...rules], c)
  assert.equal(rows.find(row => row.host === 'api.anthropic.com').coverage, 'unknown')
})
test('DNS audit redacts URL credentials and cannot substitute configuration for a leak test', () => {
  const resolver = `https://username:never-print@dns.example/dns-query?token=never-print#${c.policyGroup}`
  assert.deepEqual(safeResolver(resolver, c), { transport: 'https', host: 'dns.example', pinned: true })
  const policy = Object.fromEntries(CLAUDE_DOMAINS.map(host => [`+.${host}`, [resolver]]))
  const local = Object.fromEntries(CLAUDE_DOMAINS.map(host => [host, { server: '127.0.0.1', port: 1053 }]))
  const runtime = { ipv6: false, dns: { enable: true, ipv6: false, 'nameserver-policy': policy } }
  let result = reviewDNS(runtime, c, local)
  assert.equal(result.state, 'configured'); assert.equal(result.leakTest, 'not-tested')
  assert.ok(!JSON.stringify(result).includes('never-print'))
  delete local['claude.ai']; result = reviewDNS(runtime, c, local)
  assert.equal(result.state, 'needs-review')
  assert.equal(reviewDNS(null, c).state, 'unknown')
})
test('passive connection review shows only relevant hosts and labels coverage limits', () => {
  const result = reviewConnections({ connections: [
    { metadata: { host: 'private.company', process: 'browser', sourceIP: 'secret-ip' }, chains: ['DIRECT'] },
    { metadata: { host: 'api.anthropic.com', network: 'tcp' }, chains: [c.gatewayProxy, c.policyGroup] },
    { metadata: { host: 'claude.ai', inboundPort: c.probePort }, chains: [c.pinnedProxy] },
    { metadata: { host: 'claude.com', network: 'udp', processPath: '/secret' }, chains: ['DIRECT'] },
  ] }, c)
  assert.equal(result.state, 'needs-review'); assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].host, 'claude.com')
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.equal(reviewConnections({ connections: [] }, c).state, 'no-observed-bypass')
})
test('auxiliary failure preserves unknowns and only reads the controller', async () => {
  const calls = [], controller = { request: async path => { calls.push(path); throw new Error('private error') },
    select: () => assert.fail('diagnostics cannot switch policies') }
  const diagnostics = createDiagnostics(c, controller, async () => { throw new Error('private error') })
  const result = await diagnostics.inspect()
  assert.equal(result.state, 'partial'); assert.equal(result.dns.state, 'unknown'); assert.equal(result.observations, null)
  assert.deepEqual(calls.sort(), ['/connections', '/proxies', '/rules'])
  assert.ok(!JSON.stringify(result).includes('private error'))
})
test('client route identity requires host, source and client inbound; no arbitrary target or closed-gate test', async () => {
  const conn = { connections: [{ metadata: { host: 'claude.ai', sourcePort: 40000, inboundPort: c.clientPort }, chains: [c.gatewayProxy, c.policyGroup] }] }
  assert.equal(identifyRoute(conn, c, 'claude.ai', 40000).guarded, true)
  assert.equal(identifyRoute(conn, c, 'claude.ai', 40001).state, 'unknown')
  assert.equal(identifyRoute(conn, c, 'api.anthropic.com', 40000).state, 'unknown')
  await assert.rejects(checkClientRoute(c, {}, 'internal.example'), /Unsupported/)
  let open = false, calls = []
  const routeCheck = createRouteCheck(c, {}, { status: () => ({ gateway: { open } }) }, async (_c, _controller, host) => { calls.push(host); return { host, state: 'unavailable' } })
  assert.equal((await routeCheck.inspect()).state, 'gate-closed'); assert.equal(calls.length, 0)
  open = true; const result = await routeCheck.inspect()
  assert.deepEqual(calls, CHECK_HOSTS); assert.equal(result.rows.length, 3)
})
test('malformed auxiliary controller data returns unknown instead of crashing the guard process', async () => {
  const diagnostics = createDiagnostics(c, { request: async () => ({ rules: [null] }) }, async () => ({ runtime: null }))
  const result = await diagnostics.inspect()
  assert.equal(result.state, 'unknown'); assert.equal(result.domains.length, 0)
})
