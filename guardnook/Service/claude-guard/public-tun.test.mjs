import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPublicTun } from './public-tun.mjs'
import { validateConfig } from './config.mjs'
import { composeOwnedScript } from './owned.mjs'
import vm from 'node:vm'
test('only the exact proxy kernel UDP transport bypasses public TUN rejection, after the Claude prefix', () => {
  const kernelProcessPath = '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo'
  const c = { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed', kernelProcessPath }
  const input = { 'proxy-groups': [{ name: 'pinned', type: 'select', proxies: ['fixed'] }],
    rules: ['PROCESS-PATH-REGEX,^/Applications/Claude\\.app/,guard', 'MATCH,ordinary'] }
  const result = applyPublicTun(input, c, 1)
  assert.equal(result.rules[0], input.rules[0])
  assert.equal(result.rules[1], `AND,((IN-TYPE,TUN),(PROCESS-PATH,${kernelProcessPath}),(NETWORK,UDP)),DIRECT`)
  assert.ok(result.rules.indexOf('AND,((IN-TYPE,TUN),(NETWORK,UDP)),REJECT') > 1)
  assert.ok(!result.rules.some(r => r.startsWith('PROCESS-NAME,')))
  assert.deepEqual(applyPublicTun(result, c, 1), result)
  for (const kernelProcessPath of ['/Applications/Claude.app/Contents/MacOS/Claude', '/tmp/../mihomo', '/tmp/mihomo,DIRECT', '*']) {
    assert.throws(() => validateConfig({ kernelProcessPath }), /kernel path/)
    assert.throws(() => applyPublicTun(input, { ...c, kernelProcessPath }, 1), /kernel path/)
  }
})
test('public TUN route precedes regional direct rules, keeps intranet and never targets measurement domains', () => {
  const c = { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }
  const original = { 'proxy-groups': [{ name: 'pinned', type: 'select', proxies: ['fixed'] }],
    rules: ['DOMAIN-SUFFIX,claude.ai,guard', 'DOMAIN-SUFFIX,cn,DIRECT', 'GEOIP,CN,DIRECT,no-resolve',
      'DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet', 'MATCH,ordinary'],
    tun: { enable: false }, dns: { nameserver: ['<IP>'], 'nameserver-policy': { '+.chatgpt.com': ['<IP>#utun5'] } } }
  const before = structuredClone(original), result = applyPublicTun(original, c, 1)
  assert.deepEqual(original, before)
  assert.equal(result.rules[0], original.rules[0])
  const catchall = result.rules.indexOf('IN-TYPE,TUN,pinned')
  assert.ok(result.rules.indexOf('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet') < catchall)
  assert.ok(result.rules.indexOf('IP-CIDR,<IP>/8,DIRECT,no-resolve') < catchall)
  assert.ok(catchall < result.rules.indexOf('DOMAIN-SUFFIX,cn,DIRECT'))
  assert.ok(result.rules.indexOf('AND,((IN-TYPE,TUN),(NETWORK,UDP)),REJECT') < catchall)
  assert.ok(!result.rules.some(r => /ip138|ip\.cn|ipify/.test(r)))
  assert.deepEqual(result.dns['nameserver-policy'], before.dns['nameserver-policy'])
  assert.deepEqual(result.dns.nameserver, [
    'https://<IP>/dns-query#pinned', 'https://<IP>/dns-query#pinned',
  ])
  assert.deepEqual(result.dns.fallback, [])
  assert.deepEqual(result.tun, before.tun)
  assert.deepEqual(applyPublicTun(result,c,1), result)
  assert.deepEqual(applyPublicTun(original,{...c,publicTunExit:false},1),original)
})

test('system proxy ports route public requests before CN DIRECT without enabling TUN', () => {
  const c = { publicTunExit: false, publicProxyExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed',
    clientPort: 7901, probePort: 17903 }
  const input = { 'mixed-port': 7897, port: 7898, 'socks-port': 7897,
    'proxy-groups': [{ name: 'pinned', type: 'select', proxies: ['fixed'] }],
    rules: ['DOMAIN-SUFFIX,claude.ai,guard', 'DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet',
      'PROCESS-PATH-REGEX,^/Applications/Lark\\.app/,Codex-Intranet-Apps',
      'DOMAIN-SUFFIX,cn,DIRECT', 'GEOIP,CN,DIRECT,no-resolve', 'MATCH,ordinary'], tun: { enable: false } }
  const result = applyPublicTun(input, c, 1)
  assert.equal(result.rules[0], input.rules[0])
  for (const port of [7897, 7898]) {
    const catchall = result.rules.indexOf(`IN-PORT,${port},pinned`)
    assert.ok(catchall > result.rules.indexOf('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet'))
    assert.ok(catchall > result.rules.indexOf('PROCESS-PATH-REGEX,^/Applications/Lark\\.app/,Codex-Intranet-Apps'))
    assert.ok(catchall > result.rules.indexOf('IP-CIDR,<IP>/16,DIRECT,no-resolve'))
    assert.ok(catchall < result.rules.indexOf('DOMAIN-SUFFIX,cn,DIRECT'))
    assert.equal(result.rules.filter(rule => rule === `IN-PORT,${port},pinned`).length, 1)
  }
  assert.ok(!result.rules.some(rule => rule.startsWith('IN-TYPE,TUN,')))
  assert.deepEqual(result.tun, input.tun)
  assert.deepEqual(applyPublicTun(result, c, 1), result)
  const changed = applyPublicTun({ ...result, 'mixed-port': 8897, port: 0, 'socks-port': 0 }, c, 1)
  assert.ok(changed.rules.includes('IN-PORT,8897,pinned'))
  assert.ok(!changed.rules.includes('IN-PORT,7897,pinned'))
})

test('private guard and probe ports are not converted into ordinary public proxy ingress', () => {
  const c = { publicProxyExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed',
    clientPort: 7901, probePort: 17903, gatewayPort: 17904, serverPort: 17891 }
  const input = { 'mixed-port': 7897, port: 7901, 'socks-port': 17903,
    'proxy-groups': [{ name: 'pinned', type: 'select', proxies: ['fixed'] }], rules: [] }
  const result = applyPublicTun(input, c, 0)
  assert.ok(result.rules.includes('IN-PORT,7897,pinned'))
  assert.ok(!result.rules.includes('IN-PORT,7901,pinned'))
  assert.ok(!result.rules.includes('IN-PORT,17903,pinned'))
  assert.throws(() => applyPublicTun({ ...input, 'mixed-port': 0 }, c, 0), /listening port/)
  assert.throws(() => validateConfig({ publicProxyExit: 'true' }), /public egress/)
})

test('persistent owned script keeps the ordinary proxy rule when TUN is off', () => {
  const c = validateConfig({ publicProxyExit: true, publicTunExit: true, selectedProxy: 'US node',
    pinnedProxy: 'pinned', policyGroup: 'guard', gatewayProxy: 'gateway', coverageVersion: 1,
    ownedProtection: true, proxyPassword: 'a'.repeat(64), kernelProcessPath: '/opt/homebrew/bin/mihomo' })
  const script = composeOwnedScript('function main(c) { return c; }', c, null)
  const context = vm.createContext({ input: { mode: 'rule', 'mixed-port': 7897, tun: { enable: false },
    proxies: [{ name: 'US node', type: 'socks5', server: 'example.com', port: 443 }],
    rules: ['DOMAIN-SUFFIX,cn,DIRECT', 'MATCH,ordinary'] } })
  vm.runInContext(script, context)
  const result = JSON.parse(JSON.stringify(vm.runInContext('main(input)', context)))
  assert.equal(result.rules[0], 'DOMAIN-SUFFIX,claude.ai,guard')
  assert.ok(result.rules.includes('IN-PORT,7897,pinned'))
  assert.ok(result.rules.includes('IN-TYPE,TUN,pinned'))
  assert.ok(result.rules.includes('AND,((IN-TYPE,TUN),(PROCESS-PATH,/opt/homebrew/bin/mihomo),(NETWORK,UDP)),DIRECT'))
  assert.equal(result.tun.enable, false)
})
