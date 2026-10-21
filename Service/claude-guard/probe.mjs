import https from 'node:https'
import tls from 'node:tls'
import { connectTunnel } from './tunnel.mjs'

export function validateProbeChain(connections, c, sourcePort, inboundPort) {
  const route = connections.connections?.find(x => Number(x.metadata?.sourcePort) === sourcePort
    && Number(x.metadata?.inboundPort) === inboundPort && x.metadata?.host === 'claude.ai')
  const allowed = [c.pinnedProxy, c.pinnedEntry, c.policyGroup, c.selectedProxy, c.frozenExitProxy, ...(c.upstreamChain || [])]
  if (!route || !route.chains?.includes(c.pinnedProxy)
    || route.chains.some(x => !allowed.includes(x))) throw new Error('Probe route is not the pinned chain')
  return route.chains
}

// TLS is validated end-to-end; no browser cookies, account or Claude API call.
export async function probeExit(c, controller, port = c.probePort) {
  let raw, secure, request
  const started = Date.now()
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 })
  const deadline = setTimeout(() => {
    request?.destroy(new Error('Probe deadline exceeded'))
    secure?.destroy(new Error('Probe deadline exceeded'))
    raw?.destroy()
  }, c.timeoutMs)
  try {
    raw = await connectTunnel(c, 'claude.ai:443', port)
    const sourcePort = raw.localPort
    secure = tls.connect({ socket: raw, servername: 'claude.ai', rejectUnauthorized: true })
    agent.createConnection = () => secure
    const body = await new Promise((resolve, reject) => {
      request = https.request({ hostname: 'claude.ai', path: '/cdn-cgi/trace', method: 'GET', agent,
        headers: { 'accept-encoding': 'identity', 'user-agent': 'Claude-Egress-Guard/1' } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('Trace unavailable')); return }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { data += chunk; if (data.length > 4096) request.destroy(new Error('Trace too large')) })
        res.on('error', reject)
        res.on('end', () => resolve(data))
      })
      request.once('error', reject)
      secure.once('error', reject)
      request.end()
    })
    const trace = Object.fromEntries(body.trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)))
    if (!trace.ip) throw new Error('Trace has no exit IP')
    const chains = validateProbeChain(await controller.request('/connections'), c, sourcePort, port)
    if (Date.now() - started >= c.timeoutMs) throw new Error('Probe deadline exceeded')
    return { ip: trace.ip, location: trace.loc || '', colo: trace.colo || '', chains }
  } finally {
    clearTimeout(deadline)
    agent.destroy()
    secure?.destroy()
    raw?.destroy()
  }
}
