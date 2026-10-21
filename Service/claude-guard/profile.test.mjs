import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { DEFAULT_CONFIG, validateConfig } from './config.mjs'
import { applyClaudeGuard, composeProfileScript } from './profile.mjs'
const c = validateConfig({ proxyPassword: 'a'.repeat(64) })
function fixture() {
  return { mode: 'rule', dns: { nameserver: ['100.64.0.1'], policy: 'keep' }, tun: { enable: true },
    proxies: [{ name: c.pinnedProxy, type: 'socks5', udp: false, 'dialer-proxy': c.pinnedEntry }, { name: 'ordinary', type: 'ss' }],
    'proxy-groups': [{ name: c.policyGroup, type: 'select', proxies: [c.pinnedProxy, 'REJECT'] }, { name: 'ordinary', type: 'select', proxies: ['DIRECT'] }],
    listeners: [{ name: 'claude', type: 'http', listen: '127.0.0.1', port: c.clientPort, proxy: c.policyGroup }, { name: 'other', type: 'socks', port: 1234 }],
    rules: ['IP-CIDR,10.0.0.0/8,DIRECT', 'DOMAIN-SUFFIX,corp.example.com,DIRECT', 'MATCH,ordinary'] }
}
test('preserves ordinary/intranet/DNS/TUN and original input; no pinned fallback', () => {
  const original = fixture(), before = structuredClone(original), result = applyClaudeGuard(original, c)
  assert.deepEqual(original, before)
  assert.deepEqual(result.dns, before.dns)
  assert.deepEqual(result.tun, before.tun)
  assert.deepEqual(result['proxy-groups'][1], before['proxy-groups'][1])
  assert.deepEqual(result.proxies.slice(0, 2), before.proxies)
  assert.deepEqual(result.listeners[1], before.listeners[1])
  assert.deepEqual(result.rules.slice(7), before.rules)
  assert.deepEqual(result['proxy-groups'][0].proxies, ['REJECT', c.gatewayProxy])
  assert.equal(result.listeners[0].proxy, undefined)
  assert.equal(result.listeners.at(-1).proxy, c.pinnedProxy)
  assert.equal(result.listeners.at(-1).users.length, 1)
})
test('rejects fallback, port/name collisions, unexpected rule and unsafe modes', () => {
  for (const change of [x => x['proxy-groups'][0].proxies.push('DIRECT'), x => x.proxies[0].udp = true,
    x => x.listeners[0].rule = 'company', x => x.mode = 'global',
    x => x.listeners.push({ name: 'company', port: c.probePort })]) {
    const x = fixture(); change(x); assert.throws(() => applyClaudeGuard(x, c))
  }
  assert.throws(() => applyClaudeGuard(fixture(), DEFAULT_CONFIG))
  assert.throws(() => composeProfileScript('function main(c){return c}'))
  assert.equal(validateConfig({ expectedIP: '1.1.1.1' }).expectedIP, '1.1.1.1')
  assert.throws(() => validateConfig({ expectedIP: 'invalid' }))
  assert.throws(() => validateConfig({ probePort: DEFAULT_CONFIG.gatewayPort }))
})
test('wrapper keeps original synchronous script behavior', () => {
  const context = vm.createContext({ input: fixture() })
  vm.runInContext(composeProfileScript('function main(c) { c.marker = "preserved"; return c }', c), context)
  const output = vm.runInContext('main(input)', context)
  assert.equal(output.marker, 'preserved')
  assert.deepEqual(JSON.parse(JSON.stringify(output)), applyClaudeGuard({ ...fixture(), marker: 'preserved' }, c))
})
test('shared Google domains retire only our old gate rules and keep ordinary Google routing', () => {
  const cfg = validateConfig({ ...c, guardGoogleAuth: false, requireTun: true })
  const input = fixture()
  input.rules.unshift('DOMAIN,www.google.com,ordinary', ...['accounts.google.com', 'google.com', 'www.google.com'].map(h => `DOMAIN,${h},${c.policyGroup}`))
  const result = applyClaudeGuard(input, cfg)
  assert.ok(result.rules.includes('DOMAIN,www.google.com,ordinary'))
  assert.ok(!result.rules.some(r => /^DOMAIN,(?:accounts\.google\.com|google\.com|www\.google\.com),/.test(r) && r.endsWith(',' + c.policyGroup)))
  assert.equal(result.rules[0], 'DOMAIN-SUFFIX,claude.ai,' + c.policyGroup)
  assert.deepEqual(applyClaudeGuard(result, cfg).rules, result.rules)
  assert.throws(() => validateConfig({ guardGoogleAuth: 'false' }))
})
