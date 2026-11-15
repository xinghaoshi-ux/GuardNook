// Dedicated CONNECT relay for GuardNook's company WebView. No TLS inspection,
// cookie export, public targets, provider routing or global proxy changes.
import http from 'node:http'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { isMainModule } from './entry.mjs'
import { connectTunnel } from './tunnel.mjs'
import { readGuardConfig } from './desktop-common.mjs'
import { createController } from './controller.mjs'

export function companyDestination(authority) {
  const match = /^([a-z0-9.-]+):(443|7799)$/i.exec(authority)
  if (!match) return null
  const host = match[1].toLowerCase()
  // Observed public script/style dependencies. Never connect to them directly.
  if (Number(match[2]) === 443 && ['static1.tuyacn.com', 'cdnjs.cloudflare.com'].includes(host)) return { host, port: 443, asset: true }
  if (host !== 'tuya-inc.com' && !host.endsWith('.tuya-inc.com')) return null
  return { host, port: Number(match[2]) }
}
export function companyAddress(ip) {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 100 && p[1] >= 64 && p[1] <= 127)
}
export function createCompanyProxy({ resolve = host => lookup(host, { family: 4 }), connect = net.createConnection, assetProxyPort = 0, assetTunnel = connectTunnel } = {}) {
  const sockets = new Set()
  const track = s => { sockets.add(s); s.once('close', () => sockets.delete(s)); s.on('error', () => {}); return s }
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end() })
  server.on('connection', track)
  server.on('connect', async (req, client, head) => {
    const target = companyDestination(req.url)
    const reject = () => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    if (!target) { reject(); return }
    try {
      if (target.asset) {
        if (!Number.isInteger(assetProxyPort) || assetProxyPort < 1024 || assetProxyPort > 65535) { reject(); return }
        const upstream = track(await assetTunnel({ timeoutMs: 10000, proxyPassword: '' }, target.host + ':443', assetProxyPort))
        if (client.destroyed) { upstream.destroy(); return }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy())
        client.pipe(upstream).pipe(client); upstream.resume(); return
      }
      const address = await resolve(target.host)
      if (client.destroyed || !companyAddress(address.address)) { reject(); return }
      const upstream = track(connect({ host: address.address, port: target.port, timeout: 10000 }))
      const close = () => { upstream.destroy(); client.destroy() }
      upstream.once('timeout', close); upstream.once('error', close)
      client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy())
      upstream.once('connect', () => {
        if (client.destroyed) { upstream.destroy(); return }
        upstream.setTimeout(180000, close)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
    } catch { reject() }
  })
  server.headersTimeout = 5000; server.requestTimeout = 10000
  return { server, async start() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); return server.address().port },
    async stop() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}
if (isMainModule(import.meta.url)) {
  const index = process.argv.indexOf('--asset-proxy-port')
  let assetProxyPort = index >= 0 ? Number(process.argv[index + 1]) : 0
  if (!assetProxyPort) {
    // A disabled system-proxy switch must not turn CDN traffic into DIRECT.
    // Discover only the existing client's ordinary HTTP entrance, read-only.
    try {
      const config = await readGuardConfig(), runtime = await createController(config).request('/configs')
      const port = Number(runtime['mixed-port'] || runtime.port)
      if (Number.isInteger(port) && port >= 1024 && port <= 65535
        && ![config.clientPort, config.gatewayPort, config.probePort, config.serverPort].includes(port)) assetProxyPort = port
    } catch { /* No proxy discovery: public asset connections remain denied. */ }
  }
  const proxy = createCompanyProxy({ assetProxyPort })
  proxy.start().then(port => process.stdout.write(JSON.stringify({ port }) + '\n')).catch(() => process.exit(1))
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void proxy.stop().finally(() => process.exit(0)))
  process.stdin.resume(); process.stdin.on('end', () => void proxy.stop().finally(() => process.exit(0)))
}
