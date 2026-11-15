import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { applyCodexIntranet, composeCodexIntranetScript } from './codex-intranet.mjs'
import { applyPublicTun } from './public-tun.mjs'
const options = { openaiRouting: 'intranet', interfaceName: 'utun5', dnsServer: '<IP>', excludedNetworks: ['<IP>/10', '<IP>/32'] }
function fixture() {
  return { mode: 'rule', proxies: [{ name: 'Claude', type: 'http', password: 'private' }],
    'proxy-groups': [{ name: 'Guard', proxies: ['REJECT', 'Claude'] }],
    rules: ['DOMAIN-SUFFIX,claude.ai,Guard', 'PROCESS-NAME,claude,Guard', 'IN-PORT,7897,ordinary', 'MATCH,ordinary'],
    dns: { nameserver: ['<IP>'], 'nameserver-policy': { '+.claude.ai': ['https://example.com/dns-query#Guard'] }, 'fake-ip-filter': ['+.local'] },
    tun: { enable: true, 'dns-hijack': ['any:53'], 'route-exclude-address': ['<IP>/16'] } }
}
test('OpenAI follows ordinary network rules by default and migrates old bindings without changing company or Claude routes', () => {
  const legacyOptions = { ...options, corporateDomains: ['corp.example.com'], attachmentProxy: 'pinned',
    applicationBundles: ['/Applications/Lark.app'], applicationDomains: ['feishu.cn'], applicationDnsServer: '<IP>' }
  const input = fixture()
  input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
  const legacy = applyCodexIntranet(input, legacyOptions)
  const { openaiRouting, ...networkOptions } = legacyOptions
  const result = applyCodexIntranet(legacy, networkOptions)
  const domains = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com']
  assert.ok(!result.rules.some(rule => domains.some(domain => rule.startsWith(`DOMAIN-SUFFIX,${domain},`))))
  for (const domain of domains) {
    assert.equal(result.dns['nameserver-policy']['+.' + domain], undefined)
    assert.ok(!result.dns['fake-ip-filter'].includes('+.' + domain))
  }
  assert.deepEqual(result.rules.filter(rule => !domains.some(domain => rule.includes(domain))),
    legacy.rules.filter(rule => !domains.some(domain => rule.includes(domain))))
  assert.deepEqual(result.dns['nameserver-policy']['+.corp.example.com'], ['<IP>#utun5'])
  assert.deepEqual(result.tun, legacy.tun)
  assert.deepEqual(applyCodexIntranet(result, networkOptions), result)
  const context = vm.createContext({ input: legacy })
  const script = composeCodexIntranetScript('function main(c){return c}', networkOptions)
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(script + '\nmain(input)', context))), result)
})
test('network mode preserves subscription OpenAI routes and custom DNS while retiring managed real-IP filters', () => {
  const input = fixture()
  input.rules.splice(2, 0, 'DOMAIN-SUFFIX,chatgpt.com,ordinary')
  input.dns['nameserver-policy']['+.chatgpt.com'] = ['https://custom.example/dns-query']
  input.dns['fake-ip-filter-mode'] = 'rule'
  input.dns['fake-ip-filter'].push('DOMAIN-SUFFIX,chatgpt.com,real-ip')
  const result = applyCodexIntranet(input, { ...options, openaiRouting: 'network' })
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,chatgpt.com,ordinary'))
  assert.deepEqual(result.dns['nameserver-policy']['+.chatgpt.com'], ['https://custom.example/dns-query'])
  assert.ok(!result.dns['fake-ip-filter'].includes('DOMAIN-SUFFIX,chatgpt.com,real-ip'))
  assert.throws(() => applyCodexIntranet(input, { ...options, openaiRouting: 'invalid' }), /routing mode/)
})
test('migrating an active public TUN/proxy profile retains company exception precedence and the protected prefix', () => {
  const input = fixture()
  input['mixed-port'] = 7897
  input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
  const publicOptions = { publicTunExit: true, publicProxyExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }
  const opts = { ...options, corporateDomains: ['corp.example.com'], attachmentProxy: 'pinned' }
  const legacy = applyPublicTun(applyCodexIntranet(input, opts), publicOptions, 2)
  const network = applyPublicTun(applyCodexIntranet(legacy, { ...opts, openaiRouting: 'network' }), publicOptions, 2)
  const domains = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com']
  const ordinary = value => value.rules.filter(rule => !domains.some(domain => rule.includes(domain)))
  assert.deepEqual(ordinary(network), ordinary(legacy))
  const company = network.rules.indexOf('IP-CIDR,<IP>/10,Codex-Intranet,no-resolve')
  assert.ok(company < network.rules.indexOf('IP-CIDR,<IP>/10,DIRECT,no-resolve'))
  assert.ok(company < network.rules.indexOf('IN-TYPE,TUN,pinned'))
  assert.ok(company < network.rules.indexOf('IN-PORT,7897,pinned'))
})
test('OpenAI routes and corporate DNS survive TUN without weakening Claude or ordinary rules', () => {
  const original = fixture(), before = structuredClone(original), result = applyCodexIntranet(original, options)
  assert.deepEqual(original, before)
  assert.deepEqual(result.rules.slice(0, 2), before.rules.slice(0, 2))
  assert.deepEqual(result.rules.slice(6), before.rules.slice(2))
  assert.deepEqual(result['proxy-groups'], before['proxy-groups'])
  assert.deepEqual(result.proxies[0], before.proxies[0])
  assert.equal(result.proxies[1]['interface-name'], 'utun5')
  assert.equal(result.proxies[1].type, 'direct')
  assert.deepEqual(result.dns['nameserver-policy']['+.chatgpt.com'], ['<IP>#utun5'])
  assert.deepEqual(result.dns['nameserver-policy']['+.claude.ai'], before.dns['nameserver-policy']['+.claude.ai'])
  assert.deepEqual(result.dns.nameserver, before.dns.nameserver)
  assert.equal(result.tun.enable, true)
  assert.deepEqual(result.tun['dns-hijack'], before.tun['dns-hijack'])
  assert.deepEqual(result.tun['route-exclude-address'], ['<IP>/16', ...options.excludedNetworks])
  assert.deepEqual(applyCodexIntranet(result, options), result)
})
test('composed extension preserves original behavior and rejects repeated wrapping', () => {
  const context = vm.createContext({ input: fixture() })
  const source = composeCodexIntranetScript('function main(c) { c.marker = "preserved"; return c }', options)
  vm.runInContext(source, context)
  const result = JSON.parse(JSON.stringify(vm.runInContext('main(input)', context)))
  assert.equal(result.marker, 'preserved')
  assert.equal(result.tun.enable, true)
  assert.throws(() => composeCodexIntranetScript(source, options))
})
test('invalid interface, CIDR, DNS, name conflicts and unsafe modes fail before deployment', () => {
  for (const bad of [{ interfaceName: 'utun5;cmd' }, { dnsServer: '999.1.1.1' }, { excludedNetworks: ['0.0.0.0/0'] }, { proxyName: 'DIRECT' }]) {
    assert.throws(() => applyCodexIntranet(fixture(), { ...options, ...bad }))
  }
  assert.throws(() => applyCodexIntranet({ ...fixture(), mode: 'global' }, options))
  const c = fixture(); c.proxies.push({ name: 'Codex-Intranet', type: 'socks5' })
  assert.throws(() => applyCodexIntranet(c, options))
})
test('explicit company domains and ranges use corporate DNS and interface before public TUN routing', () => {
  const opts = { ...options, corporateDomains: ['corp.example.com'] }
  const input = fixture()
  input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
  input.rules.splice(2, 0, 'IN-TYPE,TUN,pinned')
  const c = { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }
  const result = applyPublicTun(applyCodexIntranet(input, opts), c, 2)
  assert.deepEqual(result.rules.slice(0, 2), input.rules.slice(0, 2))
  const company = result.rules.indexOf('DOMAIN-SUFFIX,corp.example.com,Codex-Intranet')
  const range = result.rules.indexOf('IP-CIDR,<IP>/10,Codex-Intranet,no-resolve')
  const generic = result.rules.indexOf('IP-CIDR,<IP>/10,DIRECT,no-resolve')
  const catchall = result.rules.indexOf('IN-TYPE,TUN,pinned')
  assert.ok(company >= 2 && company < catchall)
  assert.ok(range >= 2 && range < generic && generic < catchall)
  assert.deepEqual(result.dns['nameserver-policy']['+.corp.example.com'], ['<IP>#utun5'])
  assert.ok(result.dns['fake-ip-filter'].includes('+.corp.example.com'))
  assert.equal(result.proxies.find(p => p.name === 'Codex-Intranet')['interface-name'], 'utun5')
  assert.deepEqual(applyPublicTun(applyCodexIntranet(result, opts), c, 2), result)
  const context = vm.createContext({ input })
  vm.runInContext(composeCodexIntranetScript('function main(c){return c}', opts), context)
  assert.ok(vm.runInContext('main(input)', context).rules.includes('DOMAIN-SUFFIX,corp.example.com,Codex-Intranet'))
})
test('corporate DNS exception rejects malformed domains and cannot override protected Claude domains', () => {
  for (const domain of ['com', '*.corp.example.com', 'corp.example.com#proxy', 'CLAUDE.AI', 'claude.ai', 'api.anthropic.com', 'anthropic.com']) {
    assert.throws(() => applyCodexIntranet(fixture(), { ...options, corporateDomains: [domain] }), /corporate domain/)
  }
})
test('moving X onto the OpenAI path removes earlier ordinary and split rules', () => {
  const domains = ['x.com', 'twitter.com', 'twimg.com', 't.co']
  for (const previousKind of ['directDomains', 'splitDomains']) {
    const previous = applyCodexIntranet(fixture(), { ...options, [previousKind]: domains })
    const opts = { ...options, corporateDomains: domains }
    const result = applyCodexIntranet(previous, opts)
    assert.deepEqual(result.rules.slice(0, 2), fixture().rules.slice(0, 2))
    for (const domain of domains) {
      const matches = result.rules.filter(r => r.startsWith(`DOMAIN-SUFFIX,${domain},`) || r.includes(`(DOMAIN-SUFFIX,${domain})`))
      assert.deepEqual(matches, [`DOMAIN-SUFFIX,${domain},Codex-Intranet`])
      assert.deepEqual(result.dns['nameserver-policy']['+.' + domain], result.dns['nameserver-policy']['+.chatgpt.com'])
    }
    assert.deepEqual(applyCodexIntranet(result, opts), result)
  }
})
test('attachment exception migrates the old corporate route and DNS without moving Codex or company traffic', () => {
  for (const filterMode of ['blacklist', 'rule']) {
    const input = applyCodexIntranet(fixture(), { ...options, corporateDomains: ['corp.example.com'] })
    input.dns['fake-ip-filter-mode'] = filterMode
    if (filterMode === 'rule') input.dns['fake-ip-filter'] = ['DOMAIN-SUFFIX,oaiusercontent.com,real-ip']
    input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
    const opts = { ...options, corporateDomains: ['corp.example.com'], attachmentProxy: 'pinned' }
    const result = applyCodexIntranet(input, opts)
    assert.equal(result.rules.filter(r => r.startsWith('DOMAIN-SUFFIX,oaiusercontent.com,')).length, 1)
    assert.ok(result.rules.indexOf('DOMAIN-SUFFIX,oaiusercontent.com,pinned') < result.rules.indexOf('IN-PORT,7897,ordinary'))
    assert.ok(result.rules.includes('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet'))
    assert.ok(result.rules.includes('DOMAIN-SUFFIX,openai.com,Codex-Intranet'))
    assert.ok(result.rules.includes('DOMAIN-SUFFIX,corp.example.com,Codex-Intranet'))
    assert.deepEqual(result.rules.slice(0, 2), input.rules.slice(0, 2))
    assert.deepEqual(result.dns['nameserver-policy']['+.oaiusercontent.com'], ['https://<IP>/dns-query#pinned'])
    assert.deepEqual(result.dns['nameserver-policy']['+.chatgpt.com'], ['<IP>#utun5'])
    assert.ok(!result.dns['fake-ip-filter'].includes(filterMode === 'rule' ? 'DOMAIN-SUFFIX,oaiusercontent.com,real-ip' : '+.oaiusercontent.com'))
    assert.deepEqual(applyCodexIntranet(result, opts), result)
    const tun = applyPublicTun(result, { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }, 2)
    assert.deepEqual(applyPublicTun(applyCodexIntranet(tun, opts), { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }, 2), tun)
    const context = vm.createContext({ input })
    const script = composeCodexIntranetScript('function main(c){return c}', opts)
    const composed = JSON.parse(JSON.stringify(vm.runInContext(script + '\nmain(input)', context)))
    assert.deepEqual(composed, result)
  }
})
test('attachment exception rejects unsafe targets and blocks if the configured target disappears', () => {
  for (const attachmentProxy of ['DIRECT', 'GLOBAL', 'REJECT', 'Codex-Intranet', 'pinned,other', 'pinned#utun0']) {
    assert.throws(() => applyCodexIntranet(fixture(), { ...options, attachmentProxy }), /attachment proxy/)
  }
  const result = applyCodexIntranet(fixture(), { ...options, attachmentProxy: 'missing' })
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,oaiusercontent.com,REJECT'))
  assert.ok(!result.rules.includes('DOMAIN-SUFFIX,oaiusercontent.com,Codex-Intranet'))
  assert.deepEqual(result.dns['nameserver-policy']['+.oaiusercontent.com'], ['https://<IP>/dns-query#REJECT'])
})
test('explicit app bundles cover main and helper processes ahead of TUN and mixed-port defaults', () => {
  const input = fixture()
  input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
  const opts = { ...options, attachmentProxy: 'pinned', applicationBundles: ['/Applications/Lark.app', '/Applications/WeChat.app'], applicationDomains: ['feishu.cn'], applicationDnsServer: '<IP>' }
  const c = { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }
  const result = applyPublicTun(applyCodexIntranet(input, opts), c, 2)
  assert.deepEqual(result.rules.slice(0, 2), input.rules.slice(0, 2))
  const appRules = result.rules.filter(r => r.startsWith('PROCESS-PATH-REGEX,'))
  assert.equal(appRules.length, 2)
  assert.deepEqual(result.proxies.find(p => p.name === 'Codex-Intranet-Apps'), { name: 'Codex-Intranet-Apps', type: 'direct', udp: true, 'ip-version': 'ipv4' })
  const privateRules = result.rules.filter(r => r.startsWith('AND,((PROCESS-PATH-REGEX,'))
  assert.equal(privateRules.length, options.excludedNetworks.length * 2)
  assert.ok(privateRules.every(r => r.endsWith(',Codex-Intranet')))
  const patterns = appRules.map(r => new RegExp(r.split(',')[1]))
  for (const path of ['/Applications/Lark.app/Contents/MacOS/Feishu', '/Applications/Lark.app/Contents/Frameworks/Lark Framework.framework/Helpers/Lark Helper.app/Contents/MacOS/Lark Helper', '/Applications/WeChat.app/Contents/MacOS/WeChat']) {
    assert.ok(patterns.some(p => p.test(path)))
  }
  for (const path of ['/Applications/LarkXapp/Contents/MacOS/App', '/Applications/Lark.app.evil/Contents/MacOS/App', '/Applications/Claude.app/Contents/MacOS/Claude', '/Applications/ego.app/Contents/MacOS/ego']) {
    assert.ok(!patterns.some(p => p.test(path)))
  }
  for (const rule of appRules) {
    assert.ok(rule.endsWith(',Codex-Intranet-Apps'))
    assert.ok(result.rules.indexOf(rule) < result.rules.indexOf('IN-TYPE,TUN,pinned'))
    assert.ok(result.rules.indexOf(rule) < result.rules.indexOf('IN-PORT,7897,ordinary'))
    assert.ok(result.rules.indexOf('DOMAIN-SUFFIX,oaiusercontent.com,pinned') < result.rules.indexOf(rule))
  }
  assert.deepEqual(result.dns['nameserver-policy']['+.feishu.cn'], ['<IP>#Codex-Intranet-Apps'])
  assert.deepEqual(result.dns['nameserver-policy']['+.chatgpt.com'], ['<IP>#utun5'])
  assert.ok(!result.rules.includes('DOMAIN-SUFFIX,feishu.cn,Codex-Intranet'))
  assert.deepEqual(applyPublicTun(applyCodexIntranet(result, opts), c, 2), result)
  const script = composeCodexIntranetScript('function main(c){return c}', opts)
  const composed = new vm.Script(script + '\nmain(input)').runInNewContext({ input })
  assert.deepEqual(JSON.parse(JSON.stringify(composed)).rules.filter(r => r.startsWith('PROCESS-PATH-REGEX,')), appRules)
})
test('application rules cannot accept broad paths, rule injection or protected app bundles', () => {
  assert.throws(() => applyCodexIntranet(fixture(), { ...options, applicationDnsServer: '<IP>' }), /application DNS/)
  assert.throws(() => applyCodexIntranet(fixture(), { ...options, applicationBundles: ['/Applications/Lark.app'], applicationDnsServer: '999.1.1.1' }), /application DNS/)
  assert.throws(() => applyCodexIntranet(fixture(), { ...options, applicationBundles: ['/Applications/Lark.app'], applicationDnsServer: '<IP>', applicationDomains: ['openai.com'] }), /overlaps corporate/)
  for (const path of ['/Applications', '/Applications/Claude.app', '/Applications/GuardNook.app', '/Applications/Lark.app,REJECT', '/Applications/Lark.app\n', '/tmp/Lark.app']) {
    assert.throws(() => applyCodexIntranet(fixture(), { ...options, applicationBundles: [path] }), /application bundle/)
  }
  for (const domain of ['com', 'claude.ai', 'oaiusercontent.com', 'feishu.cn#proxy']) {
    assert.throws(() => applyCodexIntranet(fixture(), { ...options, applicationDomains: [domain] }), /application domain/)
  }
})

test('split domains migrate blanket tunnel bindings and keep private routes ahead of public routes', () => {
  const input = applyCodexIntranet(fixture(), { ...options, corporateDomains: ['corp.example.com', 'x.com'] })
  input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
  const opts = { ...options, corporateDomains: ['corp.example.com'], splitDomains: ['x.com', 'twitter.com', 'twimg.com', 't.co'] }
  const c = { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }
  const result = applyPublicTun(applyCodexIntranet(input, opts), c, 2)
  assert.deepEqual(result.rules.slice(0, 2), input.rules.slice(0, 2))
  for (const domain of opts.splitDomains) {
    const publicRule = `DOMAIN-SUFFIX,${domain},Codex-Intranet-Apps`
    assert.ok(!result.rules.includes(`DOMAIN-SUFFIX,${domain},Codex-Intranet`))
    assert.ok(result.rules.indexOf(publicRule) < result.rules.indexOf('IN-TYPE,TUN,pinned'))
    for (const cidr of options.excludedNetworks) {
      const privateRule = `AND,((DOMAIN-SUFFIX,${domain}),(IP-CIDR,${cidr})),Codex-Intranet`
      assert.ok(result.rules.indexOf(privateRule) >= 2)
      assert.ok(result.rules.indexOf(privateRule) < result.rules.indexOf(publicRule))
    }
    assert.deepEqual(result.dns['nameserver-policy']['+.' + domain], ['<IP>#utun5'])
  }
  assert.equal(result.proxies.find(p => p.name === 'Codex-Intranet-Apps')['interface-name'], undefined)
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,chatgpt.com,Codex-Intranet'))
  assert.deepEqual(applyPublicTun(applyCodexIntranet(result, opts), c, 2), result)
  const context = vm.createContext({ input })
  const composed = vm.runInContext(composeCodexIntranetScript('function main(c){return c}', opts) + '\nmain(input)', context)
  assert.deepEqual(JSON.parse(JSON.stringify(composed)).proxies, result.proxies)
  for (const domain of ['com', 'claude.ai', 'openai.com', 'oaiusercontent.com', 'x.com,REJECT', 'corp.example.com']) {
    assert.throws(() => applyCodexIntranet(fixture(), { ...opts, splitDomains: [domain] }), /split domain/)
  }
})

test('ordinary network domains drop old tunnel predicates and use the system resolver before public TUN fallback', () => {
  const input = fixture()
  input['proxy-groups'].push({ name: 'pinned', type: 'select', proxies: ['fixed'] })
  const c = { publicTunExit: true, pinnedProxy: 'pinned', frozenExitProxy: 'fixed' }
  const previous = applyPublicTun(applyCodexIntranet(input, { ...options, corporateDomains: ['corp.example.com'], splitDomains: ['x.com', 'twitter.com'] }), c, 2)
  const opts = { ...options, corporateDomains: ['corp.example.com'], directDomains: ['x.com', 'twitter.com'] }
  const result = applyPublicTun(applyCodexIntranet(previous, opts), c, 2)
  for (const domain of opts.directDomains) {
    assert.deepEqual(result.dns['nameserver-policy']['+.' + domain], ['system'])
    assert.ok(!result.rules.some(r => r.startsWith(`AND,((DOMAIN-SUFFIX,${domain}),`)))
    assert.ok(!result.rules.includes(`DOMAIN-SUFFIX,${domain},Codex-Intranet`))
    const ordinary = result.rules.indexOf(`DOMAIN-SUFFIX,${domain},Codex-Intranet-Apps`)
    assert.ok(ordinary > result.rules.indexOf('IP-CIDR,<IP>/10,Codex-Intranet,no-resolve'))
    assert.ok(ordinary < result.rules.indexOf('IN-TYPE,TUN,pinned'))
  }
  assert.deepEqual(result.rules.slice(0,2), input.rules.slice(0,2))
  assert.deepEqual(result.dns['nameserver-policy']['+.chatgpt.com'], ['<IP>#utun5'])
  assert.equal(result.proxies.find(p => p.name === 'Codex-Intranet-Apps')['interface-name'], undefined)
  assert.deepEqual(applyPublicTun(applyCodexIntranet(result, opts), c, 2), result)
  for (const domain of ['com', 'claude.ai', 'openai.com', 'oaiusercontent.com', 'x.com,REJECT', 'corp.example.com']) {
    assert.throws(() => applyCodexIntranet(input, {...opts,directDomains:[domain]}), /direct domain/)
  }
})
