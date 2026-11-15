import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { ProfileSet, wrapProfileScript } from './script-compat.mjs'
import { composeOwnedScript } from './owned.mjs'
import { validateConfig } from './config.mjs'

test('array-backed profile sets preserve duplicates, NaN and edits during iteration', () => {
  const values = new ProfileSet([NaN, NaN, -0, 0, 'a', 'a', 'b'])
  assert.equal(values.size, 4); assert.equal(values.has(NaN), true); assert.equal(Object.is([...values][1], -0), false)
  const iterator = values.values(); assert.ok(Number.isNaN(iterator.next().value))
  values.delete('a'); values.add('c'); assert.deepEqual([...iterator], [0, 'b', 'c'])
  const active = values.values(); active.next(); values.clear(); values.add('later'); assert.deepEqual([...active], ['later'])
})

test('compatibility stays scoped and preserves the original profile transformer', () => {
  const original = 'function main(c,name){c.rules=[...new Set(c.rules)];c.profileName=name;return c}'
  const context = vm.createContext({Set: class {constructor(){throw Error('native Set unavailable')}},input:{rules:['A','A','B']}})
  vm.runInContext(wrapProfileScript(original), context)
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('main(input,"subscription")', context))), {rules:['A','B'],profileName:'subscription'})
  assert.throws(()=>vm.runInContext('new Set()', context), /native Set unavailable/)
})

test('a full protected profile and its failure path do not touch the host native Set', () => {
  const c=validateConfig({selectedProxy:'exit',proxyPassword:'a'.repeat(64),coverageVersion:1,ownedProtection:true,
    publicTunExit:true,publicProxyExit:true,frozenExitProxy:'fixed',frozenSources:['exit','entry'],upstreamChain:['upstream'],upstreamBindings:{Entry:'entry'}})
  const script=composeOwnedScript('function main(c){c.rules=[...new Set(c.rules)];return c}',c,
    {openaiRouting:'network',interfaceName:'utun0',dnsServer:'<IP>',corporateDomains:['corp.example.com'],excludedNetworks:['<IP>/10']})
  const context=vm.createContext({Set:class{constructor(){throw Error('native Set unavailable')}},input:{mode:'rule','mixed-port':7897,
    proxies:[{name:'exit',type:'socks5','dialer-proxy':'Entry'},{name:'entry',type:'hysteria2'}],rules:['MATCH,DIRECT'],tun:{enable:true}}})
  vm.runInContext(script,context)
  const result=JSON.parse(JSON.stringify(vm.runInContext('main(input)',context)))
  assert.equal(result.rules[0],`DOMAIN-SUFFIX,claude.ai,${c.policyGroup}`)
  assert.ok(result.rules.includes(`IN-TYPE,TUN,${c.pinnedProxy}`));assert.ok(result.rules.includes(`IN-PORT,7897,${c.pinnedProxy}`))
  assert.ok(result.rules.includes('DOMAIN-SUFFIX,corp.example.com,Codex-Intranet'));assert.equal(result.tun.enable,true)
  vm.runInContext('input.proxies=[]',context)
  assert.equal(vm.runInContext('main(input).rules[0]',context),'DOMAIN-SUFFIX,claude.ai,REJECT')
})
