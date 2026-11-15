import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const source=await readFile(new URL('../../Sources/GuardNook/Resources/company-usage.js',import.meta.url),'utf8')
const run=new (Object.getPrototypeOf(async function(){}).constructor)('fetch','location',source)
const origin={origin:'https://cowork-cn.tuya-inc.com:7799'}
const fetchFor=(plan,personal)=>async(path,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.credentials,'same-origin')
  if(path==='/api/da/v1/user/me') return {ok:true,status:200,text:async()=>JSON.stringify({result:{csrfToken:'private-csrf'}})}
  assert.equal(options.headers['X-DA-CSRF-TOKEN'],'private-csrf')
  assert.ok(['/api/da/v1/coding-plan','/api/da/v1/quota/personal-summary'].includes(path))
  return {ok:true,status:200,text:async()=>JSON.stringify({success:true,result:path.includes('coding-plan')?plan:personal})}
}
test('company quota projection follows the live frontend schema without exposing keys or identity',async()=>{
  const raw={eligible:true,current:{planId:'p1'},plans:[{id:'p1',amount:100,period:'week'}],usage:{period:'week',limit:100,used:25},apiKey:'private-key',email:'private@example.test'}
  const result=await run(fetchFor(raw,{monthlyQuota:200,monthlyUsed:10}),origin)
  assert.equal(result.state,'ready');assert.equal(result.windows.length,1);assert.equal(result.windows[0].remainingPercent,75);assert.equal(result.windows[0].title,'本周套餐')
  assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('planId'))
})
test('company personal quota fallback does not invent missing, zero-limit or reset values',async()=>{
  const result=await run(fetchFor({eligible:false},{weeklyQuota:100,weeklyUsed:0,monthlyQuota:0,monthlyUsed:0}),origin)
  assert.equal(result.windows.length,1);assert.equal(result.windows[0].remainingPercent,100);assert.equal(result.windows[0].resetAt,null)
  const absent=await run(fetchFor({eligible:false},{}),origin);assert.equal(absent.state,'unsupported');assert.deepEqual(absent.windows,[])
})
test('company auth errors, redirects and wrong origins never become usage success',async()=>{
  const denied=await run(async()=>({ok:false,status:401}),origin);assert.equal(denied.state,'auth-required')
  let calls=0;const wrong=await run(async()=>{calls++;throw Error()}, {origin:'https://login-cn.tuya-inc.com:7799'})
  assert.equal(calls,0);assert.equal(wrong.state,'auth-required')
})

// Session material is used only inside the WebKit-origin script. Failures must
// stop before asking quota endpoints or returning authentication material.
test('company session validation fails closed and respects rate limits',async()=>{
  let calls=0
  const limited=await run(async()=>{calls++;return {ok:false,status:429}},origin)
  assert.equal(calls,1);assert.equal(limited.state,'limited');assert.ok(limited.retryAt>Date.now())
  calls=0
  const absent=await run(async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({result:{email:'private@example.test'}})}},origin)
  assert.equal(calls,1);assert.equal(absent.state,'unavailable');assert.ok(!JSON.stringify(absent).includes('private'))
})
