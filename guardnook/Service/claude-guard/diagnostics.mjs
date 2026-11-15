import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { CLAUDE_DOMAINS } from './config.mjs'

const exec = promisify(execFile)
export const SOURCES = Object.freeze({
  official: 'https://code.claude.com/docs/en/network-config',
  reference: 'https://ip.net.coffee/claude/site.html',
  browser: 'https://developer.chrome.com/docs/extensions/reference/api/privacy',
  ntp: 'https://datatracker.ietf.org/doc/html/rfc5905',
})
// A review catalogue, not an automatic routing list. Shared services stay shared.
export const DOMAIN_CATALOGUE = Object.freeze([
  ...['claude.ai', 'claude.com', 'api.anthropic.com', 'platform.claude.com', 'mcp-proxy.anthropic.com',
    'downloads.claude.ai', 'bridge.claudeusercontent.com', 'example.frame.claudeusercontent.com', 'code.claude.com', 'claudemcpcontent.com']
    .map(host => ({ host, category: 'official', purpose: host.startsWith('example.') ? 'Artifact 子域名覆盖样例' : '官方网络需求' })),
  ...['accounts.google.com', 'google.com', 'www.google.com', 'hcaptcha.com', 'hcaptcha.net', 'challenges.cloudflare.com']
    .map(host => ({ host, category: 'existing', purpose: '已有登录 / 验证码路由' })),
  ...['clau.de', 'claudemcpclient.com', 'anthropic.auth0.com',
    'anthropic.com.cdn.cloudflare.net', 'servd-anthropic-website.b-cdn.net', 'anthropic-com.ghost.io']
    .map(host => ({ host, category: 'reference', purpose: '第三方参考，需确认实际用途' })),
  ...['http-intake.logs.us5.datadoghq.com', 'browser-intake-us5-datadoghq.com', 'storage.googleapis.com', 'registry.npmjs.org', 'github.com']
    .map(host => ({ host, category: 'shared', purpose: '官方列出，但与其他软件共享' })),
  ...['cdn.usefathom.com', 'statsigapi.net', 'sentry.io', 'intercom.io', 'intercomcdn.com']
    .map(host => ({ host, category: 'shared-reference', purpose: '共用统计 / 报错 / 客服服务，需实际连接证据' })),
])

export function reviewDomains(rules, c) {
  return DOMAIN_CATALOGUE.map(item => {
    let match, uncertain = false
    for (const [index, rule] of rules.entries()) {
      if (rule.type === 'Domain' && rule.payload === item.host
        || rule.type === 'DomainSuffix' && (item.host === rule.payload || item.host.endsWith(`.${rule.payload}`))
        || rule.type === 'DomainKeyword' && item.host.includes(rule.payload)) {
        match = { index: index + 1, type: rule.type, policy: rule.proxy }; break
      }
      // UDP-only rejection cannot take an anonymous TCP HTTPS request.
      if (rule.type === 'AND' && /\(NETWORK,UDP\)/.test(rule.payload) && rule.proxy === 'REJECT') continue
      if (!['Domain', 'DomainSuffix', 'DomainKeyword'].includes(rule.type)) uncertain = true
    }
    return { ...item, source: ['reference', 'shared-reference'].includes(item.category) ? SOURCES.reference : item.category === 'existing' ? null : SOURCES.official,
      coverage: !match || uncertain ? 'unknown' : match.policy === c.policyGroup ? 'covered' : 'other', match: match || null }
  })
}

export function safeResolver(value, c) {
  if (typeof value !== 'string') return { transport: 'unknown', host: '', pinned: false }
  if (isIP(value)) return { transport: 'plain', host: value, pinned: false }
  try {
    const url = new URL(value)
    return { transport: url.protocol.slice(0, -1), host: url.hostname,
      pinned: [c.policyGroup, c.pinnedProxy].some(name => url.hash === `#${name}`) }
  } catch { return { transport: 'unknown', host: '', pinned: false } }
}
export function reviewDNS(runtime, c, resolvers = {}) {
  if (!runtime?.dns) return { state: 'unknown', evidence: 'configuration-file', rows: [], leakTest: 'not-tested' }
  const dns = runtime.dns
  const rows = CLAUDE_DOMAINS.map(host => {
    const policy = dns['nameserver-policy']?.[`+.${host}`]
    const servers = (Array.isArray(policy) ? policy : policy ? [policy] : []).map(value => safeResolver(value, c))
    const local = resolvers[host]
    const localPinned = local?.server === '127.0.0.1' && local?.port === 1053
    return { host, servers, localPinned,
      configured: dns.enable === true && servers.length > 0 && localPinned
        && servers.every(s => ['https', 'tls', 'quic'].includes(s.transport) && s.pinned) }
  })
  return { state: rows.every(row => row.configured) ? 'configured' : 'needs-review',
    evidence: 'configuration-file', enhancedMode: ['fake-ip', 'redir-host'].includes(dns['enhanced-mode']) ? dns['enhanced-mode'] : 'unknown',
    ipv6Disabled: runtime.ipv6 === false && dns.ipv6 === false, rows, leakTest: 'not-tested' }
}
export function reviewUDP(runtime, proxies, c) {
  const rules = runtime?.rules || []
  const domainReject = rules.some(rule => typeof rule === 'string' && rule.startsWith('AND,')
    && rule.endsWith(',REJECT') && rule.includes('(NETWORK,UDP)')
    && CLAUDE_DOMAINS.every(host => rule.includes(`(DOMAIN-SUFFIX,${host})`)))
  const gatewayTCPOnly = proxies?.proxies?.[c.gatewayProxy]?.udp === false
  return { state: domainReject && gatewayTCPOnly ? 'configured' : 'unknown', domainReject, gatewayTCPOnly,
    evidence: 'configuration-and-controller', leakTest: 'not-tested' }
}
export function reviewConnections(value, c) {
  const rows = []
  for (const connection of value.connections || []) {
    const m = connection.metadata || {}, host = m.host || ''
    const processClaude = /^(claude|claude-code)(\.exe)?$/i.test(m.process || '')
    if (!processClaude && !CLAUDE_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) continue
    const chains = Array.isArray(connection.chains) ? connection.chains : []
    const accepted = chains.includes(c.gatewayProxy) || chains.includes('REJECT')
      || Number(m.inboundPort) === c.probePort && chains.includes(c.pinnedProxy)
    if (!accepted) rows.push({ host: /^[a-zA-Z0-9.-]{1,253}$/.test(host) ? host : '(未提供主机名)',
      network: m.network === 'udp' ? 'udp' : 'tcp', reason: '未看到守护网关 / 私有探测链' })
  }
  return { state: rows.length ? 'needs-review' : 'no-observed-bypass', rows: rows.slice(0, 20),
    scope: '仅当前内核可见连接；未看到异常不证明其他 VPN / 浏览器没有旁路' }
}

export async function readLocalEvidence() {
  if (process.platform !== 'darwin') return { runtime: null, resolvers: {}, browser: { state: 'unknown' } }
  const path = join(homedir(), 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml')
  // Select fields inside Ruby; provider credentials never enter this response.
  const script = 'v=YAML.load_file(ARGV[0]); d=v["dns"] || {}; puts JSON.generate({dns:d.select{|k,_| ["enable","ipv6","enhanced-mode","nameserver-policy"].include?(k)},ipv6:v["ipv6"],rules:Array(v["rules"]).select{|r| r.start_with?("AND,") && r.end_with?(",REJECT") && r.include?("(NETWORK,UDP)")}})'
  const [runtime, policy, resolvers] = await Promise.all([
    exec('/usr/bin/ruby', ['-ryaml', '-rjson', '-e', script, path], { timeout: 2500, maxBuffer: 1024 * 1024 })
      .then(result => JSON.parse(result.stdout)).catch(() => null),
    exec('/usr/libexec/PlistBuddy', ['-c', 'Print :WebRtcIPHandling', join(homedir(), 'Library/Preferences/com.citrolabs.ego.lite.plist')],
      { timeout: 2500, maxBuffer: 4096 }).then(result => result.stdout.trim()).catch(() => ''),
    Promise.all(CLAUDE_DOMAINS.map(async host => {
      try {
        const text = await readFile(`/etc/resolver/${host}`, 'utf8')
        return [host, { server: text.match(/^nameserver\s+(\S+)/m)?.[1] || '', port: Number(text.match(/^port\s+(\d+)/m)?.[1] || 53) }]
      } catch { return [host, null] }
    })).then(Object.fromEntries),
  ])
  return { runtime, resolvers, browser: { state: policy === 'disable_non_proxied_udp' ? 'configured' : 'unknown',
    policy: policy === 'disable_non_proxied_udp' ? policy : '未确认', evidence: 'Ego Lite 推荐偏好，未验证实际运行窗口', leakTest: 'not-tested' } }
}

export function createDiagnostics(c, controller, readEvidence = readLocalEvidence) {
  let snapshot = { checkedAt: null, expiresAt: 0, state: 'unknown', domains: [], dns: null, udp: null, browser: null, observations: null }
  let pending, timer
  const inspect = () => {
    if (pending) return pending
    pending = (async () => {
      const results = await Promise.allSettled([controller.request('/rules'), controller.request('/proxies'), controller.request('/connections'), readEvidence()])
      const [rules, proxies, connections, evidence] = results.map(r => r.status === 'fulfilled' ? r.value : null)
      const checkedAt = Date.now()
      snapshot = { checkedAt, expiresAt: checkedAt + 120000, state: results.every(r => r.status === 'fulfilled') && evidence?.runtime ? 'reviewed' : 'partial',
        domains: rules ? reviewDomains(rules.rules || [], c) : [], dns: reviewDNS(evidence?.runtime, c, evidence?.resolvers),
        udp: reviewUDP(evidence?.runtime, proxies, c), browser: evidence?.browser || { state: 'unknown', leakTest: 'not-tested' },
        observations: connections ? reviewConnections(connections, c) : null }
      return snapshot
    })().catch(() => {
      const checkedAt = Date.now()
      snapshot = { checkedAt, expiresAt: checkedAt + 120000, state: 'unknown', domains: [],
        dns: { state: 'unknown', rows: [], leakTest: 'not-tested' }, udp: { state: 'unknown' },
        browser: { state: 'unknown', leakTest: 'not-tested' }, observations: null }
      return snapshot
    }).finally(() => { pending = undefined })
    return pending
  }
  return { status: () => snapshot, inspect,
    start() { if (!timer) { void inspect(); timer = setInterval(() => void inspect(), 60000) } },
    stop() { clearInterval(timer) } }
}
