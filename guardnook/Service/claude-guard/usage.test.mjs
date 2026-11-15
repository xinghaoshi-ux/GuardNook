import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once, EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { normalizeCodex, normalizeClaude, fetchCodex, fetchClaude, usageGuardReady, requestClaudeUsage, refreshClaudeAccess } from './usage.mjs'
import { companyDestination, companyAddress, createCompanyProxy } from './company-proxy.mjs'

const config = { clientPort: 7901, requireTun: true, expectedIP: '<IP>', policyGroup: 'guard', pinnedProxy: 'pinned' }
const ready = () => ({ state: 'protected', enabled: true, prepared: true, manual: false, tunEnabled: true,
  expectedIP: config.expectedIP, policyGroup: config.policyGroup, pinnedProxy: config.pinnedProxy,
  last: { ip: config.expectedIP }, gateway: { open: true, expiresAt: Date.now() + 15000, clientGatewayPort: 7901, destinationRestricted: true } })

test('quota normalization preserves zero usage and real window durations; never fabricates missing fields', () => {
  assert.equal(normalizeCodex({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } })[0].remainingPercent, 100)
  assert.equal(normalizeCodex({ rateLimits: { primary: { usedPercent: 77, windowDurationMins: 15 } } })[0].title, '15 分钟')
  assert.deepEqual(normalizeCodex({ rateLimits: { limitId: 'another_provider', primary: { usedPercent: 10 } } }), [])
  assert.deepEqual(normalizeClaude({ five_hour: { utilization: null }, seven_day: { utilization: 101 } }), [])
  assert.deepEqual(normalizeClaude({ five_hour: { utilization: '0' } }), [])
  const rows = normalizeClaude({ seven_day: { utilization: 100, resets_at: '2026-11-04T00:00:00Z' } })
  assert.equal(rows.length, 1); assert.equal(rows[0].remainingPercent, 0); assert.ok(rows[0].resetAt > 0)
})

test('Claude quota access requires identity, TUN, restricted client entrance and an unexpired protected lease', async () => {
  const changes = [s => { s.tunEnabled = false }, s => { s.manual = true }, s => { s.expectedIP = '<IP>' },
    s => { s.gateway.expiresAt = 1 }, s => { s.gateway.open = false }, s => { s.gateway.destinationRestricted = false },
    s => { s.gateway.clientGatewayPort = 7897 }, s => { s.policyGroup = 'other' }, s => { s.pinnedProxy = 'other' }, s => { s.prepared = false }]
  assert.equal(usageGuardReady(ready(), config), true)
  for (const mutate of changes) {
    const state = ready(); mutate(state)
    let tokens = 0, requests = 0
    const result = await fetchClaude({ configProvider: async () => config, checkProvider: async () => state,
      tokenProvider: async () => { tokens++; return 'private-token' }, requester: async () => { requests++ } })
    assert.equal(result.state, 'blocked'); assert.equal(tokens, 0); assert.equal(requests, 0)
  }
  assert.equal(usageGuardReady(ready(), { ...config, requireTun: false }), false)
})

test('a failed Claude CONNECT uses only the guarded entrance and never retries a public address', async () => {
  const calls = []
  await assert.rejects(requestClaudeUsage(config, 'private-token', { check: async () => ready(), connect: async (...args) => { calls.push(args); throw Error('closed') } }))
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 'api.anthropic.com:443'); assert.equal(calls[0][2], 7901)
  let attempts = 0
  await assert.rejects(requestClaudeUsage(config, 'private-token', { check: async () => ({ state: 'blocked' }), connect: async () => { attempts++ } }))
  assert.equal(attempts, 0)
})

test('provider exceptions and credentials do not appear in quota responses', async () => {
  const result = await fetchClaude({ configProvider: async () => config, checkProvider: async () => ready(), tokenProvider: async () => 'private-access',
    requester: async () => { throw Error('Bearer private-access refresh_token=private-refresh') } })
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('private-access')); assert.ok(!serialized.includes('private-refresh'))
  assert.equal(result.state, 'unavailable')
})

test('the company relay cannot become a route around Claude protection or a public proxy', () => {
  assert.deepEqual(companyDestination('cowork-cn.tuya-inc.com:7799'), { host: 'cowork-cn.tuya-inc.com', port: 7799 })
  for (const authority of ['api.anthropic.com:443', 'claude.ai:443', 'tuya-inc.com.attacker.test:7799', '127.0.0.1:443', 'cowork-cn.tuya-inc.com:80', 'user@cowork-cn.tuya-inc.com:7799'])
    assert.equal(companyDestination(authority), null)
  for (const ip of ['<IP>', '<IP>', '<IP>', '<IP>']) assert.equal(companyAddress(ip), true)
  for (const ip of ['<IP>', '127.0.0.1', '<IP>', '<IP>', '192.168.999.1', '::1']) assert.equal(companyAddress(ip), false)
})

test('company DNS resolving to a public IP is refused before a network connection is opened', async t => {
  let calls = 0
  const relay = createCompanyProxy({ resolve: async () => ({ address: '<IP>' }), connect: () => { calls++; throw Error() } })
  const port = await relay.start(); t.after(() => relay.stop())
  const socket = net.createConnection({ host: '127.0.0.1', port }); await once(socket, 'connect')
  let response = ''; socket.on('data', data => response += data)
  socket.write('CONNECT cowork-cn.tuya-inc.com:7799 HTTP/1.1\r\nHost: cowork-cn.tuya-inc.com:7799\r\n\r\n')
  await once(socket, 'close'); assert.match(response, /^HTTP\/1.1 403/); assert.equal(calls, 0)
})

test('company static assets require the explicit normal proxy and never fall back to direct DNS/network', async t => {
  let dns = 0, direct = 0, proxy = 0
  const relay = createCompanyProxy({ resolve: async () => { dns++; return { address: '<IP>' } },
    connect: () => { direct++; throw Error() }, assetProxyPort: 7897,
    assetTunnel: async (_config, authority, port) => { proxy++; assert.equal(authority, 'static1.tuyacn.com:443'); assert.equal(port, 7897); throw Error('normal-proxy-offline') } })
  const port = await relay.start(); t.after(() => relay.stop())
  const socket = net.createConnection({ host: '127.0.0.1', port }); await once(socket, 'connect')
  let response = ''; socket.on('data', data => response += data)
  socket.write('CONNECT static1.tuyacn.com:443 HTTP/1.1\r\nHost: static1.tuyacn.com:443\r\n\r\n')
  await once(socket, 'close'); assert.match(response, /^HTTP\/1.1 403/)
  assert.equal(proxy, 1); assert.equal(dns, 0); assert.equal(direct, 0)
  assert.equal(companyDestination('static1.tuyacn.com:7799'), null)
  assert.equal(companyDestination('cdnjs.cloudflare.com.attacker.test:443'), null)
})


test('expired Claude access is delegated to the official client and the guard is checked again', async () => {
  let requests = 0
  const options = {configProvider: async () => config, checkProvider: async () => ready(), tokenProvider: async () => ({reason:'expired'}),
    refreshProvider: async (_config, {check}) => { assert.equal(usageGuardReady(await check(), config), true); return 'new-private-access' },
    requester: async (_config, token) => { requests++; assert.equal(token, 'new-private-access'); return {provider:'claude',state:'ready'} }}
  assert.equal((await fetchClaude(options)).state, 'ready'); assert.equal(requests, 1)
  requests = 0
  const pending = await fetchClaude({...options, refreshProvider: async () => null})
  assert.equal(pending.state, 'refresh-required'); assert.equal(requests, 0)
  let open = true
  const blocked = await fetchClaude({...options, checkProvider: async () => open ? ready() : {state:'blocked'},
    refreshProvider: async () => { open = false; return 'new-private-access' }})
  assert.equal(blocked.state, 'blocked'); assert.equal(requests, 0)
})

test('official-client refresh stays sandboxed, never sends a prompt and kills its child after success', async () => {
  const c = {...config, serverPort:17891}
  let spawned = 0, killed = 0, captured
  const spawnProcess = (file,args,options) => {
    spawned++;captured={file,args,options}
    const child = new EventEmitter();child.stdin = new EventEmitter();child.stdin.destroy=()=>{};child.kill=()=>{killed++}
    return child
  }
  const common = {executable:'/local/official/claude',spawnProcess,pollMs:5,timeoutMs:100,tokenProvider:async()=>'fresh-private-token'}
  assert.equal(await refreshClaudeAccess(c,{...common,check:async()=>({state:'blocked'})}),null);assert.equal(spawned,0)
  assert.equal(await refreshClaudeAccess(c,{...common,check:async()=>ready()}),'fresh-private-token')
  assert.equal(spawned,1);assert.equal(killed,1)
  assert.equal(captured.file,'/usr/bin/sandbox-exec');assert.equal(captured.options.detached,true)
  assert.ok(captured.args.includes('/usr/bin/expect'));assert.ok(captured.args.some(s=>s.includes('--safe-mode')))
  assert.ok(captured.args.some(s=>s.includes('(deny network*)') && s.includes('localhost:7901') && s.includes('localhost:17891')))
  assert.deepEqual(captured.options.stdio,['pipe','ignore','ignore'])
  assert.equal(captured.options.env.https_proxy,'http://127.0.0.1:7901')
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL']) assert.equal(key in captured.options.env,false)
  assert.ok(!captured.args.some(s=>s.includes('fresh-private-token')))
})

test('official-client refresh stops on timeout or a closing guard without exposing process output', async () => {
  const c = {...config, serverPort:17891}
  let killed = 0
  const spawnProcess = () => {
    const child = new EventEmitter();child.stdin = new EventEmitter();child.stdin.destroy=()=>{};child.kill=()=>{killed++};return child
  }
  const common = {executable:'/local/official/claude',spawnProcess,pollMs:5,timeoutMs:25,tokenProvider:async()=>({reason:'expired'})}
  assert.equal(await refreshClaudeAccess(c,{...common,check:async()=>ready()}),null);assert.equal(killed,1)
  let checks = 0
  assert.equal(await refreshClaudeAccess(c,{...common,check:async()=>++checks===1 ? ready() : {state:'blocked'}}),null)
  assert.equal(killed,2)
})


function codexRPC(accountResponses, { noise = false, silent = false } = {}) {
  const sent = []; let reads = 0, killed = 0
  const child = new EventEmitter();child.stdout = new PassThrough()
  const emit = value => child.stdout.write(JSON.stringify(value)+'\n')
  child.stdin = new Writable({write(chunk,_encoding,callback) {
    const message=JSON.parse(chunk.toString());sent.push(message);callback()
    queueMicrotask(()=>{
      if (silent) return
      if(message.method==='initialize') emit({id:message.id,result:{}})
      if(message.method==='account/read') {
        if(noise) {emit(null);emit({id:message.id,method:'server/request',params:{}});emit({method:'account/updated',params:{authMode:null}})}
        const result=accountResponses[Math.min(reads++,accountResponses.length-1)]
        emit({id:message.id,...result})
      }
      if(message.method==='account/rateLimits/read') emit({id:message.id,result:{rateLimits:{limitId:'codex',primary:{usedPercent:40,windowDurationMins:300}}}})
    })
  }})
  child.kill=()=>{killed++;child.stdout.end()}
  return {spawnProcess:()=>child,sent,get reads(){return reads},get killed(){return killed}}
}
const codexAccount={result:{account:{type:'chatgpt',planType:'plus',email:'private@example.test'},requiresOpenaiAuth:true}}
const missingCodexAccount={result:{account:null,requiresOpenaiAuth:true}}

test('Codex account RPC errors never mean logged out and retry once without exposing errors',async()=>{
  const rpc=codexRPC([{error:{code:-32603,message:'private-secret'}},codexAccount])
  const result=await fetchCodex({executable:'/local/codex',spawnProcess:rpc.spawnProcess,retryDelayMs:1})
  assert.equal(result.state,'ready');assert.equal(result.windows[0].remainingPercent,60);assert.equal(rpc.reads,2);assert.equal(rpc.killed,1)
  assert.ok(!rpc.sent.some(m=>/thread|turn|login|logout/.test(m.method)))
  const failing=codexRPC([{error:{code:-32603,message:'private-secret'}}])
  const failed=await fetchCodex({executable:'/local/codex',spawnProcess:failing.spawnProcess,retryDelayMs:1})
  assert.equal(failed.state,'unavailable');assert.equal(failing.reads,2);assert.ok(!JSON.stringify(failed).includes('private-secret'))
})

test('Codex confirms a null account again and can recover during a transient account update',async()=>{
  const rpc=codexRPC([missingCodexAccount,codexAccount])
  assert.equal((await fetchCodex({executable:'/local/codex',spawnProcess:rpc.spawnProcess,retryDelayMs:1})).state,'ready')
  assert.equal(rpc.reads,2)
  const missing=codexRPC([missingCodexAccount])
  assert.equal((await fetchCodex({executable:'/local/codex',spawnProcess:missing.spawnProcess,retryDelayMs:1})).state,'auth-required')
  assert.equal(missing.reads,2);assert.ok(!missing.sent.some(m=>m.method==='account/rateLimits/read'))
})

test('Codex distinguishes unsupported providers and malformed replies from absent login',async()=>{
  for(const [reply,state] of [[{result:{account:null,requiresOpenaiAuth:false}},'unsupported'],[{result:{}},'unavailable']]) {
    const rpc=codexRPC([reply]);const result=await fetchCodex({executable:'/local/codex',spawnProcess:rpc.spawnProcess,retryDelayMs:1})
    assert.equal(result.state,state)
  }
})

test('Codex ignores reverse-direction request IDs and bounds a stalled process',async()=>{
  const rpc=codexRPC([codexAccount],{noise:true})
  assert.equal((await fetchCodex({executable:'/local/codex',spawnProcess:rpc.spawnProcess,retryDelayMs:1})).state,'ready')
  assert.equal(rpc.reads,1)
  const stalled=codexRPC([],{silent:true})
  assert.equal((await fetchCodex({executable:'/local/codex',spawnProcess:stalled.spawnProcess,timeoutMs:15})).state,'unavailable')
  assert.equal(stalled.killed,1)
})
