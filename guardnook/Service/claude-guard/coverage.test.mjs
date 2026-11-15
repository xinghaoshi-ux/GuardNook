import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateConfig } from './config.mjs'
import { verifyPolicy } from './guard.mjs'
import { applyClaudeGuard, composeProfileScript } from './profile.mjs'
import { applyCodexIntranet } from './codex-intranet.mjs'
import vm from 'node:vm'
const c = validateConfig({ coverageVersion: 1, proxyPassword: 'a'.repeat(64) })
// Captured from an isolated real Mihomo 1.19.29 kernel. DNS/TUN were disabled
// and no network probes were made. These are fixture rules, not live evidence.
const kernelRules = JSON.parse(readFileSync(new URL('./fixtures/coverage-mihomo-1.19.json', import.meta.url)))
function snapshot() {
  return { configs: { mode: 'rule' }, proxies: { proxies: {
    [c.policyGroup]: { type: 'Selector', all: ['REJECT', c.gatewayProxy], now: 'REJECT' },
    [c.gatewayProxy]: { type: 'Http', udp: false },
  } }, rules: { rules: structuredClone(kernelRules) } }
}
function base() {
  return { mode: 'rule', proxies: [{ name: c.pinnedProxy, type: 'socks5', udp: false }],
    'proxy-groups': [{ name: c.policyGroup, type: 'select', proxies: ['REJECT', c.pinnedProxy] }],
    listeners: [{ name: 'fixture', type: 'http', listen: '127.0.0.1', port: c.clientPort }],
    dns: { enable: true, nameserver: ['<IP>'], 'nameserver-policy': { '+.private.company': ['<IP>'] } },
    tun: { enable: true, 'route-exclude-address': ['<IP>/10'] }, rules: ['IN-PORT,7897,ordinary', 'MATCH,ordinary'] }
}
test('guard accepts actual kernel logical formatting and IPv6 CIDR representation', () => {
  assert.equal(verifyPolicy(snapshot(), c), true)
  for (const index of [7, 11, 12, 20, 28, 29]) {
    const changed = snapshot(); changed.rules.rules[index].proxy = 'other'
    assert.throws(() => verifyPolicy(changed, c), /coverage-rules-changed/)
  }
  const negated = snapshot(); negated.rules.rules[11].payload = '(NOT,' + negated.rules.rules[11].payload + ')'
  assert.throws(() => verifyPolicy(negated, c), /coverage-rules-changed/)
  const subnet = snapshot(); subnet.rules.rules[28].payload = '<IP>/24'
  assert.throws(() => verifyPolicy(subnet, c), /coverage-rules-changed/)
})
test('expanded generator retains intranet/Codex DNS and TUN; no global shared telemetry rules', () => {
  const original = base(), before = structuredClone(original), generated = applyClaudeGuard(original, c)
  assert.deepEqual(original, before)
  assert.deepEqual(generated.tun, before.tun)
  assert.deepEqual(generated.dns.nameserver, before.dns.nameserver)
  assert.deepEqual(generated.dns['nameserver-policy']['+.private.company'], ['<IP>'])
  assert.ok(generated.rules.includes(`DOMAIN-SUFFIX,claudemcpcontent.com,${c.policyGroup}`))
  assert.ok(generated.rules.includes(`PROCESS-NAME,Claude Helper (Renderer),${c.policyGroup}`))
  assert.ok(!generated.rules.some(r => /DOMAIN-SUFFIX,(sentry.io|statsigapi.net|intercom.io|intercomcdn.com),/.test(r)))
  assert.ok(!generated.rules.some(r => r.includes('<IP>/21') || r.includes('2607:6bc0::/32')))
  const combined = applyCodexIntranet(generated, { openaiRouting: 'intranet', interfaceName: 'utun5', dnsServer: '<IP>', excludedNetworks: ['<IP>/10'] })
  assert.ok(combined.rules.indexOf('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet') < combined.rules.indexOf('IN-PORT,7897,ordinary'))
  assert.deepEqual(combined.dns['nameserver-policy']['+.chatgpt.com'], ['<IP>#utun5'])
  assert.deepEqual(combined.dns['nameserver-policy']['+.claude.ai'], generated.dns['nameserver-policy']['+.claude.ai'])
  const context = vm.createContext({ input: original })
  vm.runInContext(composeProfileScript('function main(c) { c.marker = "retained"; return c }', c), context)
  assert.equal(vm.runInContext('main(input).marker', context), 'retained')
  assert.equal(vm.runInContext('main(input).rules.includes("DOMAIN-SUFFIX,claudemcpcontent.com,' + c.policyGroup + '")', context), true)
})
test('coverage version is explicit and older installed services keep their rule contract', () => {
  assert.throws(() => validateConfig({ coverageVersion: 2 }))
  const legacy = validateConfig({ proxyPassword: c.proxyPassword })
  const old = applyClaudeGuard(base(), legacy)
  assert.equal(old.rules.length, 9)
  assert.deepEqual(old.dns, base().dns)
  assert.ok(!old.rules.some(r => r.includes('claudemcpcontent.com')))
})
