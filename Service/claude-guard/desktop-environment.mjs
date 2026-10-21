import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import { isMainModule } from './entry.mjs'
import { probeSTUN } from './desktop-stun.mjs'
import { activeNetworkServices } from './clients.mjs'
import { createEnvironmentRepair } from './environment-repair.mjs'
import { run, desktopRoot, privateDirectory, regularFile, atomicJSON, guardEvidence,
  protectedStatus, readInput, reply, readGuardConfig } from './desktop-common.mjs'

export function validateBaseline(input) {
  const value = {
    country: input.country, timezone: input.timezone, locale: input.locale, language: input.language,
  }
  const standard = input.template === 'standard'
  if (input.template !== undefined && !['standard', 'strict'].includes(input.template)) throw new Error('环境模板无效。')
  if (typeof value.country !== 'string' || !(standard && value.country === '') && !/^[A-Z]{2}$/.test(value.country)) throw new Error('国家代码需为两位大写字母，例如 US。')
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format() }
  catch { throw new Error('请输入有效时区，例如 America/New_York。') }
  if (typeof value.timezone !== 'string' || !/^(?:UTC|[A-Za-z_+-]+\/[A-Za-z_+/-]+)$/.test(value.timezone)) throw new Error('时区格式无效。')
  if (typeof value.locale !== 'string' || !/^[a-z]{2,3}_[A-Z]{2}(?:@[A-Za-z0-9_=;-]+)?$/.test(value.locale)) throw new Error('地区格式无效，例如 en_US。')
  if (typeof value.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value.language)) throw new Error('语言格式无效，例如 en-US。')
  if (input.template !== undefined) value.template = input.template
  if (input.networkService !== undefined) {
    if (typeof input.networkService !== 'string' || input.networkService.length > 120 || /[\r\n\0]/.test(input.networkService)) throw new Error('网络服务名称无效。')
    value.networkService = input.networkService
  }
  return value
}
export async function baseline(home = homedir(), execute = run) {
  const file = join(desktopRoot(home), 'environment-baseline.json')
  if (await regularFile(file)) return validateBaseline(JSON.parse(await readFile(file, 'utf8')))
  const [locale, languages, services] = await Promise.all([
    execute('/usr/bin/defaults', ['read', '-g', 'AppleLocale']), execute('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']), activeNetworkServices(execute),
  ])
  const initial = { template: 'standard', country: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: /^[a-z]{2,3}_[A-Z]{2}(?:@[A-Za-z0-9_=;-]+)?$/.test(locale.text) ? locale.text : 'en_US',
    language: languages.text.match(/\b([a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})\b/)?.[1] || 'en-US', networkService: services.find(value => value.active)?.name || '' }
  await privateDirectory(desktopRoot(home))
  await atomicJSON(file, initial)
  return initial
}
export async function saveBaseline(input, home = homedir()) {
  const policy = validateBaseline(input)
  await privateDirectory(desktopRoot(home))
  await atomicJSON(join(desktopRoot(home), 'environment-baseline.json'), policy)
  return policy
}
async function https(url) {
  const result = await run('/usr/bin/curl', ['-sS', '--connect-timeout', '6', '--max-time', '12',
    '-w', '\n%{http_code}', url], { timeout: 14000 })
  if (!result.ok) return { code: 0, body: '' }
  const index = result.text.lastIndexOf('\n')
  return { code: Number(result.text.slice(index + 1)), body: result.text.slice(0, index) }
}
export function reachability(codes) {
  if (codes.some(code => !code)) return { state: 'fail', detail: '网页或 API 未取得 HTTP 响应' }
  if (codes.some(code => code === 403 || code === 429 || code >= 500))
    return { state: 'warn', detail: `已连接 · 网页 HTTP ${codes[0]} / API HTTP ${codes[1]}；存在访问限制` }
  return { state: 'ok', detail: `已连接 · 网页 HTTP ${codes[0]} / API HTTP ${codes[1]}；未验证登录或 API 权限` }
}
export function stunVerdict(addresses, expected) {
  if (!addresses.length) return { state: 'unknown', detail: '未收到 STUN 响应，不能据此证明无泄漏；浏览器需单独复测' }
  if (!expected) return { state: 'unknown', detail: '已收到探针响应，但缺少已验证的 Claude 出口用于比较' }
  if (addresses.some(ip => ip !== expected)) return { state: 'warn', detail: '探针出口与 Claude 出口不同；需在实际浏览器检查旁路' }
  return { state: 'ok', detail: '本次 STUN 探针仅观察到 Claude 出口；不代表所有浏览器' }
}
export async function inspectEnvironment({ home = homedir(), activeSTUN = false, execute = run,
  readConfig = readGuardConfig, evidenceProvider = guardEvidence, requestHTTPS = https, stunProbe = probeSTUN } = {}) {
  const policy = await baseline(home, execute)
  const [services, configured] = await Promise.all([activeNetworkServices(execute), readConfig(home).catch(() => null)])
  const network = services.find(value => value.name === policy.networkService) || services.find(value => value.active)
  const strict = policy.template !== 'standard'
  const [kernel, interfaces, timezone, locale, ipv6, dns, language, systemLanguage, evidence,
    trace, website, api, stun] = await Promise.all([
    execute('/usr/bin/pgrep', ['-f', '(^|/)(verge-mihomo|mihomo|clash-meta)( |$)']), execute('/sbin/ifconfig'),
    execute('/usr/bin/readlink', ['/etc/localtime']), execute('/usr/bin/defaults', ['read', '-g', 'AppleLocale']),
    Promise.resolve({ ok: !!network, text: network?.info || '' }),
    execute('/usr/bin/dscacheutil', ['-q', 'host', '-a', 'name', 'claude.ai'], { timeout: 5000 }),
    execute('/usr/bin/defaults', ['read', 'com.anthropic.claudefordesktop', 'AppleLanguages']),
    execute('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']),
    evidenceProvider(home).catch(() => null),
    requestHTTPS('https://claude.ai/cdn-cgi/trace'), requestHTTPS('https://claude.ai/'),
    requestHTTPS('https://api.anthropic.com/v1/models'), activeSTUN ? stunProbe() : null,
  ])
  const fields = Object.fromEntries(trace.body.split('\n').filter(line => line.includes('='))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  const exit = trace.code === 200 && isIP(fields.ip || '') === 4 ? fields.ip : null
  const guardOK = evidence && protectedStatus(evidence.status, evidence.config)
  const currentZone = timezone.text.split('/zoneinfo/')[1] || ''
  const addresses = [...dns.text.matchAll(/^ip_address:\s+(\S+)/gm)].map(match => match[1])
  const dnsOK = addresses.length > 0 && addresses.every(ip => ip.startsWith('198.18.'))
  const tunOK = evidence?.configs?.tun?.enable === true
  const tunRequired = configured?.requireTun === true
  const kernelOK = !!evidence || kernel.ok
  const languageList = [...language.text.matchAll(/\b([a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})\b/g)].map(match => match[1])
  const firstLanguage = systemLanguage.text.match(/\b([a-z]{2,3}(?:-[A-Za-z]+)*)\b/)?.[1]
  const languageOK = languageList.length ? languageList[0] === policy.language
    : firstLanguage === policy.language || firstLanguage === policy.language.split('-')[0]
  let org = '', geoTimezone = ''
  if (exit) {
    const geo = await requestHTTPS(`https://ipinfo.io/${encodeURIComponent(exit)}/json`)
    try {
      const value = JSON.parse(geo.body)
      if (geo.code === 200 && value.ip === exit) { org = value.org || ''; geoTimezone = value.timezone || '' }
    } catch { /* Network identity remains informational. */ }
  }
  const rows = []
  const row = (id, title, state, detail, blocking = false, fixable = false) => rows.push({ id, title, state: !blocking && state === 'fail' && ['country','timezone','locale','ipv6','language'].includes(id) ? 'warn' : state, detail, blocking, fixable })
  row('kernel', '代理控制接口', evidence ? 'ok' : kernelOK ? 'warn' : 'unknown', evidence ? '已连接所配置的本机控制接口' : kernelOK ? '进程在线，控制接口尚未确认' : '尚未连接代理客户端', !!configured)
  row('tun', 'TUN 配置', tunOK ? 'ok' : tunRequired ? 'fail' : 'info', tunOK ? '控制接口报告 TUN 开启；接管效果以实际出口验证为准' : tunRequired ? '当前保护策略要求开启 TUN' : '当前策略未强制 TUN；未接管的流量不在保护范围内', tunRequired, !!configured && evidence?.configs?.tun?.enable === false)
  row('country', 'Claude 出口国家', !policy.country ? 'info' : !exit ? 'unknown' : fields.loc === policy.country ? 'ok' : 'fail',
    !exit ? '未取得 Claude 服务端出口；不使用普通网页出口代替' : `${fields.loc || '未知'} · ${policy.country ? '目标 ' + policy.country : '未限制国家'}`, strict && !!policy.country)
  row('exit', '固定出口一致', guardOK && exit === evidence?.config.expectedIP ? 'ok' : 'fail',
    guardOK && exit === evidence?.config.expectedIP ? 'Claude 实测与守护目标一致' : '固定出口或守护验证未通过', !!configured)
  row('timezone', '时区基线', currentZone === policy.timezone ? 'ok' : 'fail',
    `${currentZone || '未知'} · 目标 ${policy.timezone}${geoTimezone && geoTimezone !== policy.timezone ? `；IP 地理参考 ${geoTimezone}` : ''}`, strict, currentZone !== policy.timezone)
  row('locale', '地区基线', locale.text === policy.locale ? 'ok' : 'fail', `${locale.text || '未知'} · 目标 ${policy.locale}`, strict, locale.text !== policy.locale)
  row('ipv6', (network?.name || '网络服务') + ' IPv6', /^IPv6:\s*Off/im.test(ipv6.text) ? 'ok' : 'fail',
    /^IPv6:\s*Off/im.test(ipv6.text) ? '已关闭' : (strict ? '未关闭或无法读取' : '未要求关闭；如有旁路需检查实际 IPv6 路径'), strict, ipv6.ok && !/^IPv6:\s*Off/im.test(ipv6.text))
  row('dns', '系统实际 DNS', dnsOK ? 'ok' : addresses.length ? 'warn' : 'unknown',
    dnsOK ? 'macOS 分域解析返回 Clash Fake-IP' : '未确认 Fake-IP；真实地址解析本身不代表泄漏，需检查实际请求路径', strict)
  const stunResult = activeSTUN ? stunVerdict(stun, evidence?.config.expectedIP)
    : { state: 'unknown', detail: '点击主动检测测试本进程 UDP；不代表浏览器 WebRTC' }
  row('stun', 'STUN / UDP 探针', stunResult.state, stunResult.detail)
  row('guard', 'GuardNook 保护通道', guardOK ? 'ok' : 'fail', guardOK ? '现有网关、出口租约与 TUN 条件有效' : '未确认保护；先启用并验证专线', !!configured)
  row('rules', '保护规则与代理链', evidence?.policyValid ? 'ok' : 'fail',
    evidence?.policyValid ? '现有规则顺序、固定节点链与网关契约通过' : '规则尚未接入或发生变化，请检查节点配置', !!configured)
  row('language', 'Claude 客户端语言', languageOK ? 'ok' : 'fail', `${languageList[0] || firstLanguage || '未知'} · 目标 ${policy.language}`, strict, !languageOK)
  row('asn', 'ASN / 运营商', 'info', org || '本次未取得运营商信息；不用于判断住宅 IP 或账号安全')
  const reach = reachability([website.code, api.code])
  row('reach', '网页与 API 可达性', reach.state, reach.detail)
  return { checkedAt: Date.now(), policy, services: services.map(value => value.name), configured: !!configured, rows, ready: !!configured && rows.filter(row => row.blocking).every(row => row.state === 'ok'),
    repairIds: rows.filter(row => row.fixable).map(row => row.id) }
}

export async function repairEnvironment(input, home = homedir()) {
  if (typeof input.planToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.planToken)) throw new Error('请先预览并确认环境更改。')
  return createEnvironmentRepair({ home }).repair(input.ids, await baseline(home), input.planToken)
}
export async function environmentRequest(input) {
  if (process.platform !== 'darwin') throw new Error('此功能目前支持 macOS。')
  switch (input.action) {
    case 'inspect': return { audit: await inspectEnvironment({ activeSTUN: input.activeSTUN === true }) }
    case 'baseline': return { policy: await saveBaseline(input.policy) }
    case 'repair': return await repairEnvironment(input)
    case 'preview': return await createEnvironmentRepair().preview(input.ids, await baseline())
    case 'history': return await createEnvironmentRepair().history()
    case 'restore': return await createEnvironmentRepair().restore(input.id)
    default: throw new Error('未知环境操作。')
  }
}
if (isMainModule(import.meta.url)) {
  try { reply(await environmentRequest(await readInput())) }
  catch (error) { reply({ error: error.message || '环境操作未完成。' }); process.exitCode = 1 }
}
