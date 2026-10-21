import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseline, validateBaseline, inspectEnvironment } from './desktop-environment.mjs'
import { createEnvironmentRepair, ipv6State } from './environment-repair.mjs'
import { clientAdapter, parseNetworkServices } from './clients.mjs'
import { validateSetupRoute, measureSetup, verifySetupConfirmation } from './setup-probe.mjs'
import { saveSetup, portableConfig, discover } from './setup.mjs'
import { createMaintenance } from './desktop-maintenance.mjs'
import { atomicJSON, desktopRoot, readGuardConfig } from './desktop-common.mjs'
async function home(t) { const home=await mkdtemp(join(tmpdir(),'guardnook-product-'));t.after(()=>rm(home,{recursive:true,force:true}));return home }
const policy={template:'standard',country:'',timezone:'Etc/UTC',locale:'zh_CN',language:'zh-Hans-CN',networkService:'USB Ethernet'}
function system() {
 const state={zone:'America/New_York',locale:'en_US',languages:['en-US'],ipv6:'Automatic'}, calls=[]
 const execute=async(file,args=[])=>{
  calls.push([file,args])
  let text=''
  if(file.endsWith('readlink'))text='/var/db/timezone/zoneinfo/'+state.zone
  else if(args[0]==='-listallnetworkservices')text='An asterisk (*) denotes a disabled network service.\nUSB Ethernet\n*Disabled VPN\nWi-Fi'
  else if(args[0]==='-getinfo')text='IP address: 192.0.2.5\nIPv6: '+state.ipv6
  else if(file.endsWith('defaults')){
   if(args[0]==='read'){
    const val=args[2]==='AppleLocale'?state.locale:state.languages
    return {ok:val!==null,text:Array.isArray(val)?'('+val.join(',')+')':val||''}
   }
   if(args[2]==='AppleLocale')state.locale=args[0]==='delete'?null:args[3]
   else state.languages=args[0]==='delete'?null:args.slice(4)
  } else if(file.endsWith('osascript')){
   const command=args.at(-1)
   if(command.includes('-settimezone'))state.zone=command.match(/-settimezone '([^']+)'/)[1]
   if(command.includes('-setv6'))state.ipv6=command.includes('-setv6off')?'Off':command.includes('-setv6automatic')?'Automatic':'Link-local only'
  } else if(file.endsWith('dscacheutil'))text='ip_address: 192.0.2.25'
  return {ok:true,text}
 }
 return {state,calls,execute}
}
test('new baseline preserves local preferences and service names; old policy remains strict',async t=>{
 const h=await home(t), sys=system()
 const fresh=await baseline(h,sys.execute)
 assert.equal(fresh.template,'standard');assert.equal(fresh.country,'');assert.equal(fresh.locale,'en_US');assert.equal(fresh.networkService,'USB Ethernet')
 const old={country:'US',timezone:'America/New_York',locale:'en_US',language:'en-US'}
 await atomicJSON(join(desktopRoot(h),'environment-baseline.json'),old)
 assert.deepEqual(await baseline(h,sys.execute),old)
 assert.equal(validateBaseline({...policy,timezone:'UTC'}).timezone,'UTC')
 assert.equal(validateBaseline(policy).language,'zh-Hans-CN')
 assert.throws(()=>validateBaseline({...policy,template:'all-green'}))
 assert.deepEqual(parseNetworkServices('An asterisk (*) denotes a disabled network service.\nUSB Ethernet\n*Disabled VPN'),['USB Ethernet'])
 assert.equal(clientAdapter('mihomo',h).persistentTun,false)
 assert.throws(()=>clientAdapter('../other',h))
})
async function auditFixture(t,template,requireTun,tun=false){
 const h=await home(t),sys=system();await mkdir(desktopRoot(h),{recursive:true})
 await atomicJSON(join(desktopRoot(h),'environment-baseline.json'),{...policy,template,country:template==='strict'?'US':''})
 const config={expectedIP:'203.0.113.8',requireTun}
 const evidence={config,policyValid:true,configs:{tun:{enable:tun}},status:{state:'protected',enabled:true,prepared:true,tunEnabled:tun,
 expectedIP:config.expectedIP,last:{ip:config.expectedIP},gateway:{open:true,expiresAt:Date.now()+30000}}}
 const audit=await inspectEnvironment({home:h,execute:sys.execute,readConfig:async()=>config,evidenceProvider:async()=>evidence,
 requestHTTPS:async url=>url.includes('cdn-cgi')?{code:200,body:'ip=203.0.113.8\nloc=JP'}:url.includes('ipinfo')?{code:200,body:'{}'}:{code:200,body:''}})
 return {audit,sys}
}
test('standard checks do not force English, Fake-IP or disabled IPv6; guard TUN contract still blocks',async t=>{
 const {audit}=await auditFixture(t,'standard',false)
 assert.equal(audit.ready,true)
 for(const id of ['timezone','locale','language','dns','ipv6','country','tun'])assert.equal(audit.rows.find(x=>x.id===id).blocking,false,id)
 assert.equal(audit.rows.find(x=>x.id==='ipv6').title,'USB Ethernet IPv6')
 const blocked=await auditFixture(t,'standard',true)
 assert.equal(blocked.audit.ready,false);assert.equal(blocked.audit.rows.find(x=>x.id==='tun').blocking,true)
})
test('strict template still honors requireTun false while enforcing explicit environment choices',async t=>{
 const {audit}=await auditFixture(t,'strict',false)
 assert.equal(audit.ready,false);assert.equal(audit.rows.find(x=>x.id==='tun').blocking,false)
 assert.equal(audit.rows.find(x=>x.id==='locale').blocking,true)
})
test('unknown guard evidence cannot become a protected success or bypass kernel checks',async t=>{
 const h=await home(t),sys=system();await mkdir(desktopRoot(h),{recursive:true});await atomicJSON(join(desktopRoot(h),'environment-baseline.json'),policy)
 const audit=await inspectEnvironment({home:h,execute:sys.execute,readConfig:async()=>({requireTun:true}),evidenceProvider:async()=>{throw Error('offline')},requestHTTPS:async()=>({code:0,body:''})})
 assert.equal(audit.ready,false);assert.equal(audit.rows.find(x=>x.id==='tun').blocking,true)
})
test('preview is read-only; repair and restoration preserve complete locale/language state',async t=>{
 const h=await home(t),sys=system(),manager=createEnvironmentRepair({home:h,execute:sys.execute})
 const preview=await manager.preview(['locale','language','ipv6'],policy)
 assert.equal(preview.plan.length,3);assert.equal(sys.state.locale,'en_US')
 assert.ok(!sys.calls.some(([file,args])=>file.endsWith('osascript')||args[0]==='write'))
 const result=await manager.repair(['locale','language','ipv6'],policy)
 assert.equal(result.history[0].status,'applied');assert.equal(sys.state.locale,'zh_CN');assert.deepEqual(sys.state.languages,['zh-Hans-CN']);assert.equal(sys.state.ipv6,'Off')
 await manager.restore(result.history[0].id)
 assert.equal(sys.state.locale,'en_US');assert.deepEqual(sys.state.languages,['en-US']);assert.equal(sys.state.ipv6,'Automatic')
 assert.equal((await manager.history()).history[0].status,'restored')
})
test('absent preferences are deleted on restore, not replaced with invented defaults',async t=>{
 const h=await home(t),sys=system();sys.state.languages=null
 const manager=createEnvironmentRepair({home:h,execute:sys.execute}), result=await manager.repair(['language'],policy)
 assert.equal(result.history[0].status,'applied')
 await manager.restore(result.history[0].id);assert.equal(sys.state.languages,null)
})
test('partial failure retains a recoverable snapshot and does not execute later changes',async t=>{
 const h=await home(t),sys=system()
 const execute=async(file,args)=>file.endsWith('osascript')?{ok:false,text:''}:sys.execute(file,args)
 const manager=createEnvironmentRepair({home:h,execute}),result=await manager.repair(['locale','ipv6','language'],policy)
 assert.equal(result.history[0].status,'partial');assert.equal(sys.state.locale,'zh_CN');assert.deepEqual(sys.state.languages,['en-US'])
 const recovered=createEnvironmentRepair({home:h,execute:sys.execute})
 await recovered.restore(result.history[0].id);assert.equal(sys.state.locale,'en_US')
})
test('external changes are not overwritten by restoration and newer repairs must be restored first',async t=>{
 const h=await home(t),sys=system(),manager=createEnvironmentRepair({home:h,execute:sys.execute})
 const first=await manager.repair(['locale'],policy)
 sys.state.locale='ja_JP'
 const conflict=await manager.restore(first.history[0].id)
 assert.equal(conflict.history[0].status,'restore-partial');assert.equal(sys.state.locale,'ja_JP')
 sys.state.locale='zh_CN'
 const second=await manager.repair(['language'],policy)
 await assert.rejects(manager.restore(first.history[0].id),/较新/)
 await manager.restore(second.history[0].id);await manager.restore(first.history[0].id)
 assert.equal(sys.state.locale,'en_US')
})
test('manual IPv6 requires complete recoverable parameters; active operations are locked',async t=>{
 assert.throws(()=>ipv6State('IPv6: Manual\nIPv6 IP address: ::1'),/不完整/)
 const h=await home(t),sys=system(),manager=createEnvironmentRepair({home:h,execute:sys.execute})
 await manager.history();await atomicJSON(join(desktopRoot(h),'environment-backups-v2/operation.lock'),{pid:process.pid})
 await assert.rejects(manager.repair(['locale'],policy),/另一项/);assert.equal(sys.state.locale,'en_US')
 await assert.rejects(manager.restore('../../outside'),/无效/)
})
test('generic Mihomo TUN is runtime-only; restore blocks protected routes before disabling TUN',async t=>{
 const h=await home(t),sys=system();let enabled=false;const selections=[]
 const c={clientID:'mihomo',requireTun:true,controllerURL:'http://127.0.0.1:9090',policyGroup:'guard',expectedIP:'203.0.113.1'}
 const manager=createEnvironmentRepair({home:h,execute:sys.execute,getConfig:async()=>c,controllerFor:()=>({request:async(path,method,body)=>{if(method==='PATCH'){enabled=body.tun.enable;return null}return {tun:{enable:enabled}}},select:async name=>selections.push(name)})})
 const result=await manager.repair(['tun'],policy);assert.equal(enabled,true);assert.equal(result.history[0].status,'applied')
 await manager.restore(result.history[0].id);assert.equal(enabled,false);assert.deepEqual(selections,['REJECT'])
 assert.equal((await readdir(join(h,'Library/Application Support'))).includes('io.github.clash-verge-rev.clash-verge-rev'),false)
})
test('setup probe refuses the wrong route, changing exits, forged confirmations and changed upstreams',async t=>{
 const h=await home(t),input={controllerURL:'http://127.0.0.1:9090',selectedProxy:'node',resolvedUpstream:['entry']}
 assert.throws(()=>validateSetupRoute({connections:[{metadata:{sourcePort:3,inboundPort:4,host:'claude.ai'},chains:['DIRECT']}]},input,3,4))
 const controller={request:async()=>({'mixed-port':7897})}
 let counter=0
 await assert.rejects(measureSetup(desktopRoot(h),input,controller,async()=>({ip:'203.0.113.'+(++counter)})),/不同/)
 const result=await measureSetup(desktopRoot(h),input,controller,async()=>({ip:'203.0.113.5',country:'JP'}))
 const confirmed={...input,setupVersion:2,confirmChanges:true,expectedIP:'203.0.113.5',probeID:result.measured.id}
 await verifySetupConfirmation(desktopRoot(h),confirmed)
 await assert.rejects(verifySetupConfirmation(desktopRoot(h),{...confirmed,expectedIP:'203.0.113.6'}),/改变/)
 await assert.rejects(verifySetupConfirmation(desktopRoot(h),{...confirmed,resolvedUpstream:['other']}),/改变/)
 await assert.rejects(verifySetupConfirmation(desktopRoot(h),{...confirmed,confirmChanges:false}),/确认/)
 await assert.rejects(verifySetupConfirmation(desktopRoot(h),{...confirmed,manualExit:true}),/手动/)
 await verifySetupConfirmation(desktopRoot(h),{...confirmed,manualExit:true,confirmManualExit:true})
})
test('failed v2 setup confirmation never replaces existing configuration',async t=>{
 const h=await home(t),root=desktopRoot(h);await mkdir(root,{recursive:true});await writeFile(join(root,'config.json'),'keep me')
 await assert.rejects(saveSetup(root,{setupVersion:2,expectedIP:'203.0.113.8',selectedProxy:'node',manualExit:true,confirmChanges:false},async()=>({nodes:[{name:'node'}]})))
 assert.equal(await readFile(join(root,'config.json'),'utf8'),'keep me')
})
test('monitor mode cannot silently reuse another installed guard',async t=>{
 const h=await home(t),root=desktopRoot(h);await mkdir(root,{recursive:true});await atomicJSON(join(root,'monitor.json'),{mode:'monitor'})
 await assert.rejects(readGuardConfig(h),/基础监测/)
})
test('detaching own connection blocks first, preserves snapshots, and explicit restore never auto-enables',async t=>{
 const h=await home(t),root=desktopRoot(h);await mkdir(root,{recursive:true})
 const c=portableConfig({expectedIP:'203.0.113.8',selectedProxy:'node',startProtected:true},'a'.repeat(64))
 await atomicJSON(join(root,'config.json'),c)
 const calls=[],manager=createMaintenance({home:h,controllerFor:()=>({select:async value=>calls.push(value)})})
 await assert.rejects(manager.detach(false),/确认/)
 const detached=await manager.detach(true);assert.deepEqual(calls,['REJECT']);assert.equal(detached.maintenance.configured,false)
 await assert.rejects(readGuardConfig(h),/基础监测/)
 await manager.restore(detached.maintenance.latestConnection,true)
 const restored=JSON.parse(await readFile(join(root,'config.json'),'utf8'));assert.equal(restored.startProtected,false);assert.equal(restored.proxyPassword,c.proxyPassword)
})
test('detaching an external service changes only this app connection; live account operations block detach',async t=>{
 const h=await home(t),root=desktopRoot(h);await mkdir(root,{recursive:true})
 const c={...portableConfig({expectedIP:'203.0.113.8',selectedProxy:'node'},''),serviceMode:'existing'}
 await atomicJSON(join(root,'config.json'),c)
 const manager=createMaintenance({home:h,controllerFor:()=>assert.fail('external service must not be altered')})
 await mkdir(join(root,'accounts'));await atomicJSON(join(root,'accounts/operation.lock'),{pid:process.pid})
 await assert.rejects(manager.detach(true),/账号/);await rm(join(root,'accounts/operation.lock'))
 const result=await manager.detach(true);assert.match(result.note,/独立守护继续运行/)
})
test('repair refuses a stale preview before writing or prompting for privilege',async t=>{
 const h=await home(t),sys=system(),manager=createEnvironmentRepair({home:h,execute:sys.execute})
 const preview=await manager.preview(['locale'],policy)
 sys.state.locale='ja_JP'
 const before=sys.calls.length
 await assert.rejects(manager.repair(['locale'],policy,preview.planToken),/重新预览/)
 assert.equal(sys.state.locale,'ja_JP');assert.equal((await manager.history()).history.length,0)
 assert.ok(!sys.calls.slice(before).some(([file,args])=>file.endsWith('osascript')||args[0]==='write'))
 const fresh=await manager.preview(['locale'],policy)
 const result=await manager.repair(['locale'],policy,fresh.planToken)
 assert.equal(result.history[0].status,'applied')
})

test('automatic discovery does not broadcast supplied credentials to other local endpoints',async()=>{
 const calls=[]
 const input={clientID:'mihomo',controllerURL:'http://127.0.0.1:19123',controllerSocket:'',controllerSecret:'test-only-credential'}
 await assert.rejects(discover(input,async value=>{calls.push(value.controllerURL);throw Error('offline')}))
 assert.deepEqual(calls,[input.controllerURL])
})

test('verified legacy connections retain the explicitly chosen client adapter without replacing credentials',async t=>{
 const h=await home(t),root=desktopRoot(h)
 await mkdir(root,{recursive:true});await mkdir(join(h,'Library/Application Support/ClaudeGuard'),{recursive:true})
 const original={...portableConfig({expectedIP:'203.0.113.8',selectedProxy:'node'},'a'.repeat(64))};delete original.clientID
 await atomicJSON(join(h,'Library/Application Support/ClaudeGuard/config.json'),original)
 const primary={...original,clientID:'mihomo',serviceMode:'existing'};delete primary.proxyPassword
 await atomicJSON(join(root,'config.json'),primary)
 const restored=await readGuardConfig(h)
 assert.equal(restored.clientID,'mihomo');assert.equal(restored.proxyPassword,original.proxyPassword)
})
