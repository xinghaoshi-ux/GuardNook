import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { validateConfig } from './config.mjs'
import { createController } from './controller.mjs'
import { PORTABLE_DEFAULTS, portableConfig, nodeCatalogue, saveSetup, detectUpstreamChain, discover, findExistingGuard } from './setup.mjs'
import { prepareSelectedProfile, applyClaudeGuard, composeProfileScript } from './profile.mjs'
import { verifyPolicy, createGuard } from './guard.mjs'
import { validateProbeChain } from './probe.mjs'
const input = { expectedIP: '198.51.100.9', selectedProxy: 'My Japan node' }
const c = portableConfig(input, 'a'.repeat(64))
test('new portable routes report missing integration instead of probing an absent listener',async()=>{
 const controller={request:async path=>path==='/configs'?{mode:'rule'}:path==='/proxies'?{proxies:{}}:{rules:[]}}
 const gateway={status:()=>({open:false}),closeAll:()=>{}}
 const guard=createGuard(c,controller,gateway,async()=>assert.fail('An uninstalled listener must not be probed'))
 const status=await guard.inspect()
 assert.equal(status.enabled,false);assert.equal(status.state,'observe');assert.equal(status.reason,'guard-route-not-installed')
})
test('portable IP, loopback endpoints, ports and chain are validated without the owner IP', () => {
 assert.equal(c.expectedIP, input.expectedIP)
 for (const controllerURL of ['http://example.com:9090', 'https://127.0.0.1:9090', 'http://127.0.0.1:9090/path', 'http://user:pass@localhost:9090', 'http://127.0.0.1', 'http://localhost:9090?x=1'])
  assert.throws(() => validateConfig({ controllerURL }))
 assert.throws(() => validateConfig({ controllerSecret: 'bad\r\nsecret' }))
 assert.throws(() => portableConfig({ ...input, upstreamChain: ['DIRECT'] }, 'a'.repeat(64)))
 assert.throws(() => portableConfig({ ...input, clientPort: PORTABLE_DEFAULTS.probePort }, 'a'.repeat(64)))
})
test('catalogue only returns concrete node metadata and omits private fields and changing groups', () => {
 const nodes = nodeCatalogue({ proxies: { DIRECT: { type:'Direct' }, group:{ type:'Selector', all:['node'] }, node:{ type:'Socks5', server:'private', password:'secret', udp:true } } })
 assert.deepEqual(nodes,[{name:'node',type:'Socks5',udp:true,upstreamChain:[]}])
})
test('fixed upstream chains are inferred recursively, without credentials or variable groups', () => {
 const snapshot={proxies:{exit:{type:'Socks5','dialer-proxy':'entry',password:'private'},entry:{type:'Hysteria2','dialer-proxy':'first'},first:{type:'Socks5'}}}
 assert.deepEqual(detectUpstreamChain(snapshot,'exit'),['entry','first'])
 assert.deepEqual(nodeCatalogue(snapshot).find(n=>n.name==='exit').upstreamChain,['entry','first'])
 assert.ok(!JSON.stringify(nodeCatalogue(snapshot)).includes('private'))
 snapshot.proxies.entry={'type':'Selector',all:['first'],now:'first'}
 assert.deepEqual(detectUpstreamChain(snapshot,'exit'),['first'])
 assert.deepEqual(nodeCatalogue(snapshot).find(n=>n.name==='exit').upstreamBindings,{entry:'first'})
 snapshot.proxies.entry={type:'URLTest',all:['first'],now:'first'}
 assert.throws(()=>detectUpstreamChain(snapshot,'exit'))
 assert.ok(nodeCatalogue(snapshot).find(n=>n.name==='exit').chainError)
 snapshot.proxies.entry={type:'Socks5','dialer-proxy':'exit'}
 assert.throws(()=>detectUpstreamChain(snapshot,'exit'))
 delete snapshot.proxies.entry
 assert.throws(()=>detectUpstreamChain(snapshot,'exit'))
 assert.deepEqual(nodeCatalogue({proxies:{'Claude-guard-gateway':{type:'Http'},'GuardNook-Gateway':{type:'Http'}}}),[])
})
test('discovery tries only known local controllers and does not change routes',async()=>{
 const attempts=[]
 const result=await discover({},async input=>{
  attempts.push([input.controllerSocket,input.controllerURL])
  if(!input.controllerURL)throw new Error('No socket')
  return {nodes:[],version:'test'}
 })
 assert.deepEqual(attempts,[[PORTABLE_DEFAULTS.controllerSocket,''],['','http://127.0.0.1:9090']])
 assert.equal(result.controllerURL,'http://127.0.0.1:9090')
 await assert.rejects(discover({},async()=>{throw new Error('unreachable')}))
})
test('save rechecks and persists detected upstreams and refuses unsafe chains before writing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'guardnook-chain-save-'))
 try{
  await saveSetup(root,input,async()=>({nodes:[{name:input.selectedProxy,upstreamChain:['entry']}]}))
  const before=await readFile(join(root,'config.json'),'utf8')
  assert.deepEqual(JSON.parse(before).upstreamChain,['entry'])
  await assert.rejects(saveSetup(root,input,async()=>({nodes:[{name:input.selectedProxy,chainError:'unsafe'}]})))
  assert.equal(await readFile(join(root,'config.json'),'utf8'),before)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('an already installed matching guard is reused without routing writes, credentials or enabling changes',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises')
 const root=await mkdtemp(join(tmpdir(),'guardnook-existing-'))
 let legacy,snapshot,status,requests=[]
 const server=http.createServer((req,res)=>{
  requests.push(req.method+' '+req.url)
  const values={'/configs':snapshot.configs,'/proxies':snapshot.proxies,'/rules':snapshot.rules,
   '/api/claude-guard/status':status,'/api/mihomo/proxies':snapshot.proxies}
  res.end(JSON.stringify(values[req.url]||{}))
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 try{
  const controllerURL=`http://127.0.0.1:${server.address().port}`
  legacy=validateConfig({expectedIP:input.expectedIP,pinnedProxy:input.selectedProxy,policyGroup:'Existing-Guard',gatewayProxy:'Existing-Gateway',controllerURL,serverPort:server.address().port,proxyPassword:'b'.repeat(64)})
  snapshot={configs:{mode:'rule'},proxies:{proxies:{[legacy.pinnedProxy]:{type:'Socks5'},[legacy.policyGroup]:{type:'Selector',all:['REJECT',legacy.gatewayProxy],now:'REJECT'},[legacy.gatewayProxy]:{type:'Http',udp:false}}},rules:{rules:['claude.ai','claude.com','anthropic.com','claudeusercontent.com'].map(payload=>({type:'DomainSuffix',payload,proxy:legacy.policyGroup})).concat(['accounts.google.com','google.com','www.google.com'].map(payload=>({type:'Domain',payload,proxy:legacy.policyGroup})))}}
  status={expectedIP:legacy.expectedIP,enabled:true,manual:true,state:'blocked'}
  await mkdir(join(root,'ClaudeGuard'));await writeFile(join(root,'ClaudeGuard/config.json'),JSON.stringify(legacy))
  const before=await readFile(join(root,'ClaudeGuard/config.json'),'utf8')
  const saved=await saveSetup(join(root,'GuardNook'),{...input,controllerURL},async()=>({nodes:[{name:input.selectedProxy}]}))
  assert.equal(saved.reusedExistingGuard,true);assert.equal(saved.scriptPath,undefined)
  const attached=JSON.parse(await readFile(join(root,'GuardNook/config.json'),'utf8'))
  assert.equal(attached.serviceMode,'existing');assert.equal(attached.serverPort,legacy.serverPort)
  assert.equal(attached.policyGroup,legacy.policyGroup);assert.equal(attached.proxyPassword,undefined)
  assert.equal(await readFile(join(root,'ClaudeGuard/config.json'),'utf8'),before)
  assert.ok(requests.every(r=>r.startsWith('GET ')));assert.equal(status.manual,true)
  assert.equal(await findExistingGuard(join(root,'GuardNook'),portableConfig({...input,expectedIP:'198.51.100.10',controllerURL},'')),null)
  status.expectedIP='198.51.100.10'
  assert.equal(await findExistingGuard(join(root,'GuardNook'),portableConfig({...input,controllerURL},'')),null)
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
})
test('authenticated loopback controller works; errors do not disclose credentials', async () => {
 const secret='local-test-secret'
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${secret}`); res.end(JSON.stringify({version:'test'}))})
 server.listen(0,'127.0.0.1'); await once(server,'listening')
 try { const client=createController(validateConfig({ controllerURL:`http://127.0.0.1:${server.address().port}`,controllerSecret:secret })); assert.deepEqual(await client.request('/version'),{version:'test'}) }
 finally { await new Promise(resolve=>server.close(resolve)) }
})
function original() {return {mode:'rule',proxies:[{name:c.selectedProxy,type:'socks5',udp:true}], 'proxy-groups':[{name:'Ordinary',type:'select',proxies:['DIRECT']}],rules:['MATCH,Ordinary'],dns:{nameserver:['1.1.1.1']},tun:{enable:true}}}
test('selected node profile preserves ordinary traffic, DNS, TUN and original credentials, with no alternate exit', () => {
 const value=original(),before=structuredClone(value)
 const prepared=applyClaudeGuard(prepareSelectedProfile(value,c),c)
 assert.deepEqual(value,before)
 assert.deepEqual(prepared.proxies[0],before.proxies[0])
 assert.deepEqual(prepared.dns,before.dns);assert.deepEqual(prepared.tun,before.tun)
 assert.deepEqual(prepared['proxy-groups'].find(g=>g.name===c.pinnedProxy).proxies,[c.selectedProxy])
 assert.equal(prepared['proxy-groups'].find(g=>g.name===c.pinnedProxy)['disable-udp'],true)
 assert.deepEqual(prepared['proxy-groups'].find(g=>g.name===c.policyGroup).proxies,['REJECT',c.gatewayProxy])
 assert.throws(()=>prepareSelectedProfile(prepared,c))
 const context=vm.createContext({input:value})
 vm.runInContext(composeProfileScript('function main(c){ c.marker = 1; return c; }',c),context)
 assert.equal(vm.runInContext('main(input)',context).marker,1)
})
test('provider node references are supported; proxy groups and reserved names cannot become an upstream', () => {
 const value=original();value.proxies=[];value['proxy-providers']={subscription:{type:'http',url:'https://example.com/private'}}
 const pinned=prepareSelectedProfile(value,c)['proxy-groups'].at(-2)
 assert.deepEqual(pinned.use,['subscription']);assert.equal(pinned.filter,'^My Japan node$');assert.equal(pinned['empty-fallback'],'REJECT')
 assert.doesNotThrow(()=>applyClaudeGuard(prepareSelectedProfile(value,c),c))
 assert.throws(()=>prepareSelectedProfile({...original(),'proxy-groups':[{name:c.selectedProxy,type:'select',proxies:['DIRECT']}]},c))
 assert.throws(()=>portableConfig({...input,selectedProxy:'DIRECT'},'a'.repeat(64)))
})
test('fixed selector edits and unexpected dialer hops fail verification for configured users', () => {
 const snapshot={configs:{mode:'rule'},proxies:{proxies:{[c.policyGroup]:{type:'Selector',all:['REJECT',c.gatewayProxy],now:'REJECT'},[c.gatewayProxy]:{type:'Http',udp:false},[c.pinnedProxy]:{type:'Selector',all:[c.selectedProxy],now:c.selectedProxy,udp:false}}},rules:{rules:['claude.ai','claude.com','anthropic.com','claudeusercontent.com'].map(payload=>({type:'DomainSuffix',payload,proxy:c.policyGroup})).concat(['accounts.google.com','google.com','www.google.com'].map(payload=>({type:'Domain',payload,proxy:c.policyGroup})))}}
 assert.equal(verifyPolicy(snapshot,c),true)
 snapshot.proxies.proxies[c.pinnedProxy].all.push('other');assert.throws(()=>verifyPolicy(snapshot,c))
 const conn={connections:[{metadata:{host:'claude.ai',sourcePort:40000,inboundPort:c.probePort},chains:[c.selectedProxy,c.pinnedProxy]}]}
 assert.deepEqual(validateProbeChain(conn,c,40000,c.probePort),conn.connections[0].chains)
 conn.connections[0].chains.unshift('unexpected');assert.throws(()=>validateProbeChain(conn,c,40000,c.probePort))
})
test('saving is private, preserves the original script and does not silently choose a removed node', async () => {
 const root=await mkdtemp(join(tmpdir(),'guardnook-setup-'))
 try {
  const saved=await saveSetup(root,{...input,originalScript:'function main(c){c.marker=1;return c}'},async()=>({nodes:[{name:c.selectedProxy}]}))
  const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'))
  assert.equal(config.expectedIP,input.expectedIP);assert.match(config.proxyPassword,/^[a-f0-9]{64}$/)
  assert.equal((await stat(join(root,'config.json'))).mode & 0o777,0o600)
  assert.equal((await stat(saved.scriptPath)).mode & 0o777,0o600)
  assert.match(await readFile(saved.scriptPath,'utf8'),/c.marker=1/)
  assert.throws(()=>composeProfileScript(awaitDummy(),c))
  const before=await readFile(join(root,'config.json'),'utf8')
  await assert.rejects(saveSetup(root,input,async()=>({nodes:[]})))
  assert.equal(await readFile(join(root,'config.json'),'utf8'),before)
  await saveSetup(root,input,async()=>({nodes:[{name:c.selectedProxy}]}))
  assert.equal(JSON.parse(await readFile(join(root,'config.json'),'utf8')).proxyPassword,config.proxyPassword)
 } finally {await rm(root,{recursive:true,force:true})}
})
function awaitDummy(){return '// __previousClaudeMain\nfunction main(c){return c}'}
test('private config destination rejects a symlink and leaves its target untouched', async () => {
 const root=await mkdtemp(join(tmpdir(),'guardnook-setup-link-'))
 try {await symlink(join(root,'target'),join(root,'config.json')); await assert.rejects(saveSetup(root,input,async()=>({nodes:[{name:c.selectedProxy}]})))}
 finally{await rm(root,{recursive:true,force:true})}
})
test('CLI entry works from a symlinked application path and returns only safe node metadata', async () => {
 const {spawn}=await import('node:child_process')
 const {fileURLToPath}=await import('node:url')
 const root=await mkdtemp(join(tmpdir(),'guardnook-entry-test-'))
 const server=http.createServer((req,res)=>res.end(JSON.stringify(req.url==='/version'?{version:'test'}:{proxies:{node:{type:'Socks5',password:'must-not-appear'}}})))
 server.listen(0,'127.0.0.1');await once(server,'listening')
 try {
  const alias=join(root,'AliasedService');await symlink(fileURLToPath(new URL('.',import.meta.url)),alias)
  const child=spawn(process.execPath,[join(alias,'setup.mjs')],{stdio:['pipe','pipe','pipe']})
  let output='';child.stdout.on('data',chunk=>{output+=chunk})
  const finished=once(child,'close')
  child.stdin.end(JSON.stringify({operation:'catalogue',controllerURL:`http://127.0.0.1:${server.address().port}`}))
  const [code]=await finished;assert.equal(code,0)
  const result=JSON.parse(output);assert.deepEqual(result.nodes,[{name:'node',type:'Socks5',udp:false,upstreamChain:[]}]);assert.ok(!output.includes('must-not-appear'))
 } finally {await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
})
test('the bundled service entry runs through an alias, stays observational, and exits after its parent quits', async () => {
 const {spawn}=await import('node:child_process')
 const {fileURLToPath}=await import('node:url')
 const net=await import('node:net')
 const free=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
 const root=await mkdtemp(join(tmpdir(),'guardnook-parent-test-'))
 const ports=await Promise.all(Array.from({length:5},free))
 const cfg=portableConfig({...input,controllerURL:`http://127.0.0.1:${ports[0]}`,serverPort:ports[1],clientPort:ports[2],probePort:ports[3],gatewayPort:ports[4]},'a'.repeat(64))
 const {writeFile}=await import('node:fs/promises')
 const parent=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})
 let child
 try {
  await symlink(fileURLToPath(new URL('.',import.meta.url)),join(root,'Alias'))
  await writeFile(join(root,'config.json'),JSON.stringify(cfg));await writeFile(join(root,'index.html'),'service test')
  child=spawn(process.execPath,[join(root,'Alias/main.mjs'),'--config',join(root,'config.json'),'--static',root,'--parent-pid',String(parent.pid)],{stdio:'ignore'})
  const closed=once(child,'close')
  let state
  for(let i=0;i<30;i++){try{state=await (await fetch(`http://127.0.0.1:${cfg.serverPort}/api/claude-guard/status`)).json();break}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.equal(state?.expectedIP,input.expectedIP);assert.equal(state?.enabled,false);assert.equal(state?.gateway.open,false)
  const parentClosed=once(parent,'close');parent.kill();await parentClosed
  const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Orphaned service did not stop')),5000);timer.unref()})
  const [code]=await Promise.race([closed,timeout]);assert.equal(code,0)
 } finally {if(parent.exitCode===null)parent.kill();if(child?.exitCode===null)child.kill();await rm(root,{recursive:true,force:true})}
})
