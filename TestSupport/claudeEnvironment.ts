import type { GuardDiagnostics, GuardStatus } from './GuardTypes'

export const CLIENT_CHECK_MAX_AGE = 5 * 60 * 1000
export function claudeEnvironment(status: GuardStatus | null, diagnostics: GuardDiagnostics | null,
  now: number, receivedAt: number, unreachable: boolean, diagnosticError = false) {
  // The display clock updates once a second; a response may land between ticks.
  const statusFresh = !unreachable && receivedAt > 0 && receivedAt <= now + 1500 && now - receivedAt < 5000
  const coreReady = statusFresh && !!status?.enabled && !!status.prepared && status.state === 'protected'
    && status.gateway.open && status.gateway.expiresAt > now && status.last?.ip === '203.0.113.10'
  const auditFresh = !diagnosticError && !!diagnostics?.checkedAt && diagnostics.checkedAt <= now + 1500
    && diagnostics.expiresAt > now
  const rows = diagnostics?.routeCheck?.rows || []
  const recentRows = rows.filter(row => row.checkedAt <= now + 1500 && now - row.checkedAt < CLIENT_CHECK_MAX_AGE)
  const clientReady = ['claude.ai', 'api.anthropic.com'].every(host => recentRows.some(row => row.host === host
    && row.state === 'verified' && row.ip === '203.0.113.10' && row.route.guarded))
  const clientProblem = recentRows.some(row => row.host !== 'www.cloudflare.com'
    && ['mismatch', 'needs-review', 'unavailable'].includes(row.state))
  const configReady = auditFresh && diagnostics?.dns?.state === 'configured' && diagnostics.udp?.state === 'configured'
  const observedBypass = auditFresh && diagnostics?.observations?.state === 'needs-review'
  const browserVerified = auditFresh && diagnostics?.browser?.leakTest === 'verified'
    && diagnostics?.dns?.leakTest === 'verified'
  if (!statusFresh || !status) return { state: 'unknown', title: '尚未确认 Claude 网络环境',
    detail: '守护状态未取得或已过期，请先检查。', coreReady: false, auditFresh, clientReady: false, browserVerified: false }
  if (status.enabled && !coreReady) return { state: 'blocked', title: '暂时不要打开或登录 Claude',
    detail: 'Claude 通道已关闭；线路恢复并完成验证后才会放行。', coreReady, auditFresh, clientReady, browserVerified: false }
  if (!status.enabled) return { state: 'unknown', title: '保护尚未启用，先不要登录',
    detail: '目前仅观测网络，启用保护后再检查。', coreReady, auditFresh, clientReady, browserVerified: false }
  if (observedBypass || clientProblem) return { state: 'review', title: '发现异常，暂缓打开或登录',
    detail: observedBypass ? '发现没有经过守护通道的 Claude 连接，请查看检查详情。' : '客户端出口或代理链未通过，建议先阻断 Claude 并检查线路。',
    coreReady, auditFresh, clientReady, browserVerified: false }
  if (!configReady || !clientReady || !diagnostics?.observations) return { state: 'unknown', title: '专线正常，登录前再检查一次',
    detail: !clientReady ? '需要重新验证 Claude 网页和 API 的实际连接路径。' : '环境配置或异常连接检查尚未完成。',
    coreReady, auditFresh, clientReady, browserVerified: false }
  return { state: 'ready', title: '受控连接已验证，可以打开 Claude',
    detail: '网页和 API 均经守护通道，出口为 203.0.113.10；线路异常时自动阻断。',
    coreReady, auditFresh, clientReady, browserVerified }
}
