import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { connectTunnel } from './tunnel.mjs'

export const CHECK_HOSTS = Object.freeze(['claude.ai', 'api.anthropic.com', 'www.cloudflare.com'])

export function identifyRoute(connections, c, host, sourcePort) {
  const connection = connections.connections?.find(x => x.metadata?.host === host
    && Number(x.metadata?.sourcePort) === sourcePort && Number(x.metadata?.inboundPort) === c.clientPort)
  if (!connection || !Array.isArray(connection.chains)) return { state: 'unknown', guarded: false }
  return { state: 'observed', guarded: connection.chains.includes(c.gatewayProxy)
    && (c.ownedProtection || connection.chains.includes(c.policyGroup)), chains: connection.chains }
}
// One anonymous fixed endpoint at a time; never follows redirects or sends credentials.
export async function checkClientRoute(c, controller, host) {
  if (!CHECK_HOSTS.includes(host)) throw new Error('Unsupported diagnostic host')
  let raw, secure, request
  const started = Date.now(), agent = new https.Agent({ keepAlive: true, maxSockets: 1 })
  const deadline = setTimeout(() => { request?.destroy(new Error('Diagnostic deadline')); secure?.destroy(); raw?.destroy() }, c.timeoutMs)
  try {
    raw = await connectTunnel(c, `${host}:443`, c.clientPort)
    const sourcePort = raw.localPort
    secure = tls.connect({ socket: raw, servername: host, rejectUnauthorized: true })
    agent.createConnection = () => secure
    const response = await new Promise((resolve, reject) => {
      request = https.request({ hostname: host, path: '/cdn-cgi/trace', method: 'GET', agent,
        headers: { 'accept-encoding': 'identity', 'user-agent': 'Claude-Egress-Guard-Diagnostic/1' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('error', reject)
        res.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error('Response too large')) })
        res.on('end', () => resolve({ code: res.statusCode, body }))
      })
      request.once('error', reject); secure.once('error', reject); request.end()
    })
    const route = identifyRoute(await controller.request('/connections'), c, host, sourcePort)
    if (Date.now() - started >= c.timeoutMs) throw new Error('Diagnostic deadline')
    const trace = Object.fromEntries(response.body.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    const ip = response.code === 200 && isIP(trace.ip || '') ? trace.ip : null
    return { host, checkedAt: Date.now(), durationMs: Date.now() - started, httpCode: response.code, ip, route,
      state: host === 'www.cloudflare.com' && !c.ownedProtection ? 'ordinary' : !route.guarded ? 'needs-review'
        : ip === c.expectedIP ? 'verified' : ip ? 'mismatch' : 'exit-unavailable' }
  } catch { return { host, checkedAt: Date.now(), durationMs: Date.now() - started,
    state: 'unavailable', ip: null, route: { state: 'unknown', guarded: false } } }
  finally { clearTimeout(deadline); agent.destroy(); secure?.destroy(); raw?.destroy() }
}
export function createRouteCheck(c, controller, guard, check = checkClientRoute) {
  let pending, snapshot = { checkedAt: null, rows: [], state: 'not-tested' }
  const inspect = () => {
    if (pending) return pending
    pending = (async () => {
      if (!guard.status().gateway?.open) return snapshot = { checkedAt: Date.now(), rows: [], state: 'gate-closed' }
      const rows = []
      for (const host of CHECK_HOSTS) rows.push(await check(c, controller, host))
      snapshot = { checkedAt: Date.now(), rows, state: 'completed' }
      return snapshot
    })().finally(() => { pending = undefined })
    return pending
  }
  return { status: () => snapshot, inspect }
}
