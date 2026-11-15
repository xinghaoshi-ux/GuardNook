// Runs in the company's own WebKit origin. Cookies remain inside WebKit.
// The return value is a strict display-only projection, never a raw response.
const now = Date.now();
const failure = (state, note) => ({provider:'company',state,checkedAt:now,windows:[],note,route:'intranet'});
if (location.origin !== 'https://cowork-cn.tuya-inc.com:7799') return failure('auth-required','请先完成公司统一登录。');
const read = async (path, headers = {}) => {
  try {
    const response = await fetch(path,{method:'GET',headers,credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});
    if (!response.ok) return {status:response.status};
    const text = await response.text();
    if (text.length > 262144) return {status:0};
    let body = JSON.parse(text);
    for(let i=0;i<4;i++) {
      if(body && typeof body==='object' && body.result && typeof body.result==='object') body=body.result;
      else if(body && typeof body==='object' && body.data && typeof body.data==='object') body=body.data;
      else break;
    }
    return {status:200,body};
  } catch (_) { return {status:0}; }
};
// The official frontend requires a CSRF header even for quota GETs. Obtain
// it in this isolated WebKit world and never send it across the native bridge.
const session = await read('/api/da/v1/user/me');
if(session.status===429) return {...failure('limited','公司会话接口限流，稍后自动重试。'),retryAt:now+300000};
if(session.status===401) return failure('auth-required','公司登录已失效，请重新连接。');
const csrf=session.body?.csrfToken;
if(typeof csrf!=='string' || !csrf.length || csrf.length>4096) return failure('unavailable','公司会话验证未完成，请在公司窗口确认登录状态。');
const headers={'X-DA-CSRF-TOKEN':csrf};
const [planReply, personalReply] = await Promise.all([read('/api/da/v1/coding-plan',headers),read('/api/da/v1/quota/personal-summary',headers)]);
const plan=planReply.body, personal=personalReply.body;
const number = x => typeof x==='number' && Number.isFinite(x) && x>=0;
const reset = x => {
  const n=typeof x==='string'?Date.parse(x):typeof x==='number'?(x<4102444800?x*1000:x):NaN;
  return Number.isFinite(n) && n>0 && n<4102444800000?n:null;
};
const windowFor = (id,title,used,limit,resetsAt) => number(used) && number(limit) && limit>0
  ? {id,title,remainingPercent:Math.round(Math.max(0,Math.min(100,(limit-used)/limit*100))*10)/10,resetAt:reset(resetsAt)}:null;
let windows=[];
const active=plan?.current?.plan || (Array.isArray(plan?.plans)?plan.plans.find(p=>p.id===plan.current?.planId):null);
if(plan?.eligible===true && active) {
  const period=plan.usage?.period || active.period;
  const limit=plan.usage?.limit ?? active.amount;
  const used=plan.usage?.used ?? (period==='week'?personal?.weeklyUsed:period==='month'?personal?.monthlyUsed:undefined);
  const w=windowFor('coding-plan',period==='week'?'本周套餐':period==='month'?'本月套餐':'当前套餐',used,limit,plan.usage?.resetAt ?? plan.usage?.resetsAt);
  if(w) windows.push(w);
} else if(personal && typeof personal==='object') {
  const week=windowFor('weekly','本周额度',personal.weeklyUsed,personal.weeklyQuota,personal.weeklyResetAt);
  const month=windowFor('monthly','本月额度',personal.monthlyUsed,personal.monthlyQuota,personal.monthlyResetAt);
  if(week)windows.push(week);if(month)windows.push(month);
}
if(windows.length) return {provider:'company',state:'ready',checkedAt:now,fetchedAt:now,windows,note:'公司 Coding Plan · 本机独立登录 · 只读查询',route:'intranet'};
if([planReply,personalReply].every(r=>r.status===401)) return failure('auth-required','公司登录已失效，请重新连接。');
if([planReply,personalReply].some(r=>r.status===403)) return failure('unavailable','公司额度接口未授权，请在公司页面确认套餐权限。');
if([planReply,personalReply].some(r=>r.status===429)) return {...failure('limited','公司用量接口限流，稍后自动重试。'),retryAt:now+300000};
if(planReply.status===200 || personalReply.status===200) return failure('unsupported','已连接公司账号，当前没有可识别的有效额度窗口。');
return failure('unavailable','公司额度请求未完成，请确认办公网络或重新连接。');
