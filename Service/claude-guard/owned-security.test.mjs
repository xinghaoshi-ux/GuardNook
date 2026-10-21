import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { validateConfig } from './config.mjs'
import { prepareSelectedProfile, applyClaudeGuard } from './profile.mjs'
import { composeOwnedScript } from './owned.mjs'
import { nodeCatalogue } from './setup.mjs'
import { createGuard } from './guard.mjs'
import { containClaude } from './containment.mjs'

const c = validateConfig({ selectedProxy: 'US exit', expectedIP: '203.0.113.20', coverageVersion: 1, frozenExitProxy: 'GuardNook-FrozenExit',
  frozenSources: ['US exit', 'US entry'], upstreamChain: ['GuardNook-FrozenUpstream-1'], upstreamBindings: { Entry: 'US entry' }, proxyPassword: 'a'.repeat(64) })
const base = () => ({ mode: 'rule', proxies: [{ name: 'US exit', type: 'socks5', server: '127.0.0.1', port: 1, username: 'fixture', password: 'fixture', 'dialer-proxy': 'Entry' },
  { name: 'US entry', type: 'anytls', server: 'entry.example', port: 443 }, { name: 'other entry', type: 'anytls', server: 'other.example', port: 443 }],
  'proxy-groups': [{ name: 'Entry', type: 'select', proxies: ['US entry', 'other entry'] }], rules: ['MATCH,DIRECT'], dns: { nameserver: ['10.50.0.1'] } })
test('selector-based node is selectable and the resulting private chain never follows its mutable selector', () => {
  const nodes = nodeCatalogue({ proxies: { exit: { type: 'Socks5', 'dialer-proxy': 'Entry' }, Entry: { type: 'Selector', all: ['US entry'], now: 'US entry' }, 'US entry': { type: 'AnyTLS' } } })
  assert.deepEqual(nodes.find(n => n.name === 'exit').upstreamChain, ['US entry'])
  const input = base(), prepared = applyClaudeGuard(prepareSelectedProfile(input, c), c)
  assert.deepEqual(input, base())
  const exit = prepared.proxies.find(p => p.name === c.frozenExitProxy)
  assert.equal(exit['dialer-proxy'], 'GuardNook-FrozenUpstream-1')
  assert.equal(prepared.proxies.find(p => p.name === 'GuardNook-FrozenUpstream-1').server, 'entry.example')
  prepared['proxy-groups'][0].proxies.reverse()
  assert.equal(exit['dialer-proxy'], 'GuardNook-FrozenUpstream-1')
  assert.equal(c.expectedIP, '203.0.113.20')
  assert.deepEqual(prepared['proxy-groups'].find(p => p.name === c.pinnedProxy).proxies, [c.frozenExitProxy])
})
test('a broken or changed subscription still rejects Claude while independently preserving Codex intranet', () => {
  const intranet = { interfaceName: 'utun5', dnsServer: '10.50.0.1', excludedNetworks: ['100.64.0.0/10'] }
  const owned = validateConfig({ ...c, ownedProtection: true })
  const script = composeOwnedScript('function main(c){throw new Error("old subscription removed")}', owned, intranet)
  const context = vm.createContext({ input: base() }); vm.runInContext(script, context)
  let result = JSON.parse(JSON.stringify(vm.runInContext('main(input)', context)))
  assert.equal(result.rules[0], 'DOMAIN-SUFFIX,claude.ai,' + c.policyGroup)
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet'))
  assert.ok(result.rules.indexOf(`IN-PORT,${c.clientPort},${c.policyGroup}`) < result.rules.indexOf('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet'))
  assert.equal(result.listeners.find(l => l.port === c.clientPort).proxy, c.gatewayProxy)
  const missing = base(); missing.proxies = missing.proxies.filter(p => p.name !== 'US exit')
  context.input = missing; result = JSON.parse(JSON.stringify(vm.runInContext('main(input)', context)))
  assert.equal(result.rules[0], 'DOMAIN-SUFFIX,claude.ai,REJECT')
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet'))
  assert.deepEqual(result.dns['nameserver-policy']['+.chatgpt.com'], ['10.50.0.1#utun5'])
})
test('changing a frozen hop to a selector closes an already verified gate even if the probe would return the correct IP', async () => {
  const rules = JSON.parse(readFileSync(new URL('./fixtures/coverage-mihomo-1.19.json', import.meta.url)))
  const proxies = { proxies: { [c.policyGroup]: { type: 'Selector', all: ['REJECT', c.gatewayProxy], now: 'REJECT' },
    [c.gatewayProxy]: { type: 'Http', udp: false }, [c.pinnedProxy]: { type: 'Selector', all: [c.frozenExitProxy], now: c.frozenExitProxy, udp: false },
    [c.frozenExitProxy]: { type: 'Socks5', 'dialer-proxy': c.upstreamChain[0] }, [c.upstreamChain[0]]: { type: 'Hysteria2', 'dialer-proxy': '' } } }
  let open = false, repair = 0
  const controller = { request: async p => p === '/configs' ? { mode: 'rule' } : p === '/proxies' ? proxies : { rules }, select: async () => {} }
  const gateway = { status: () => ({ open }), closeAll: () => { open = false }, grant: () => { open = true } }
  const guard = createGuard(c, controller, gateway, async () => ({ ip: c.expectedIP }), { contain: async () => { assert.equal(open, false); repair++ } })
  await guard.enable(); await guard.inspect(); await guard.inspect(); assert.equal(open, true)
  proxies.proxies[c.frozenExitProxy]['dialer-proxy'] = 'Entry'
  await guard.inspect(); assert.equal(open, false); assert.equal(guard.status().reason, 'frozen-chain-changed'); assert.equal(repair, 1)
  await guard.dispose()
})
test('a real-shaped policy does not permit a measured US exit when the configured target remains Japan', async () => {
  const oldTarget = validateConfig({ coverageVersion: 1, expectedIP: '203.0.113.10', proxyPassword: c.proxyPassword })
  const rules = JSON.parse(readFileSync(new URL('./fixtures/coverage-mihomo-1.19.json', import.meta.url)))
  let open = false, repaired = 0
  const proxies = { proxies: { [oldTarget.policyGroup]: { type: 'Selector', all: ['REJECT', oldTarget.gatewayProxy], now: 'REJECT' }, [oldTarget.gatewayProxy]: { type: 'Http', udp: false } } }
  const controller = { request: async p => p === '/configs' ? { mode: 'rule' } : p === '/proxies' ? proxies : { rules }, select: async () => {} }
  const gate = { status: () => ({ open }), closeAll: () => { open = false }, grant: () => { open = true } }
  const guard = createGuard(oldTarget, controller, gate, async () => ({ ip: '203.0.113.20' }), { contain: async () => { assert.equal(open, false); repaired++ } })
  await guard.enable(); for (let i = 0; i < 4; i++) await guard.inspect()
  assert.equal(guard.status().reason, 'exit-ip-mismatch'); assert.equal(open, false); assert.equal(oldTarget.expectedIP, '203.0.113.10')
  rules.length = 0; await guard.inspect(); assert.equal(open, false); assert.equal(repaired, 1)
  await guard.dispose()
  assert.equal(containClaude({ rules: ['MATCH,ordinary'] }).rules[0], 'DOMAIN-SUFFIX,claude.ai,REJECT')
})
