import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { connectTunnel, proxyAuthorization } from './tunnel.mjs'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

export function gatewayDestinationAllowed(c, hostname, port) {
  if (c.gatewayAllowlist == null) return true
  const host = domainToASCII(hostname.toLowerCase().replace(/\.$/, ''))
  // HTTPS services only. IP literals, local names and all unlisted destinations
  // are refused before any DNS lookup, admission check or upstream connection.
  return port === 443 && !!host && !isIP(host)
    && c.gatewayAllowlist.some(domain => host === domain || host.endsWith('.' + domain))
}

export function createGateway(c, onEvent = () => {}, beforeConnect = async () => {}) {
  const sockets = new Set()
  let expiresAt = 0, timer
  const alive = () => expiresAt > Date.now()
  const track = socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    return socket
  }
  const closeAll = () => {
    expiresAt = 0
    clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
  }
  const createProxyServer = requireAuthentication => {
  const authorized = req => {
    if (!requireAuthentication) return true
    const actual = Buffer.from(req.headers['proxy-authorization'] || '')
    const expected = Buffer.from(proxyAuthorization(c))
    return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) { res.writeHead(407); res.end(); return }
    let url
    try { url = new URL(req.url); if (url.protocol !== 'http:' || url.username || url.password) throw new Error() }
    catch { res.writeHead(400); res.end(); return }
    if (!gatewayDestinationAllowed(c, url.hostname, Number(url.port || 80))) { res.writeHead(403); res.end(); return }
    if (!alive()) { res.writeHead(503); res.end(); return }
    try { await beforeConnect() } catch { if (!res.destroyed) { res.writeHead(503); res.end() } return }
    if (res.destroyed) return
    if (!alive()) { res.writeHead(503); res.end(); return }
    const headers = { ...req.headers, host: url.host, connection: 'close', 'proxy-authorization': proxyAuthorization(c) }
    delete headers['proxy-connection']
    const upstream = http.request({ host: '127.0.0.1', port: c.probePort,
      method: req.method, path: url.href, headers }, response => {
      if (!alive()) { upstream.destroy(); res.destroy(); return }
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on('socket', track)
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
    onEvent({ host: url.hostname, protocol: 'HTTP', at: Date.now() })
  })
  server.on('connection', track)
  server.on('connect', async (req, client, head) => {
    const deny = status => client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    if (!authorized(req)) { deny('407 Proxy Authentication Required'); return }
    if (!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):[0-9]{1,5}$/.test(req.url)) { deny('400 Bad Request'); return }
    const port = Number(req.url.slice(req.url.lastIndexOf(':') + 1))
    if (!port || port > 65535) { deny('400 Bad Request'); return }
    const host = req.url.slice(0, req.url.lastIndexOf(':'))
    if (!gatewayDestinationAllowed(c, host, port)) { deny('403 Destination Forbidden'); return }
    if (!alive()) { deny('503 Guard Closed'); return }
    try { await beforeConnect() } catch { deny('503 Guard Closed'); return }
    if (!alive() || client.destroyed) { deny('503 Guard Closed'); return }
    try {
      const upstream = track(await connectTunnel(c, req.url))
      // A block/expiry may occur while the upstream CONNECT is pending.
      if (!alive() || client.destroyed) { upstream.destroy(); deny('503 Guard Closed'); return }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
      upstream.resume()
      client.once('close', () => upstream.destroy())
      upstream.once('close', () => client.destroy())
      onEvent({ host: req.url.slice(0, req.url.lastIndexOf(':')), protocol: 'CONNECT', at: Date.now() })
    } catch { deny('502 Upstream Unavailable') }
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10000
  return server
  }
  const server = createProxyServer(true)
  // The restricted client must enter this filter directly. Sending it through
  // a general Mihomo listener lets localhost/DIRECT or global-mode routing
  // bypass the destination check before reaching this gateway.
  const clientServer = c.ownedProtection && c.gatewayAllowlist != null ? createProxyServer(false) : null
  const servers = [server, ...(clientServer ? [clientServer] : [])]
  const closeServer = s => s.listening ? new Promise(resolve => s.close(resolve)) : Promise.resolve()
  return {
    address: () => server.address(),
    clientAddress: () => clientServer?.address(),
    async start() {
      try {
        for (const [index, s] of servers.entries()) await new Promise((resolve, reject) => {
          s.once('error', reject); s.listen(index === 0 ? c.gatewayPort : c.clientPort, '127.0.0.1', resolve)
        })
      } catch (error) { closeAll(); await Promise.all(servers.map(closeServer)); throw error }
    },
    closeAll,
    grant(until) {
      if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + c.leaseMs + 50) throw new Error('Invalid lease')
      expiresAt = until
      clearTimeout(timer)
      timer = setTimeout(closeAll, Math.max(0, until - Date.now()))
    },
    status: () => ({ open: alive(), expiresAt, connections: sockets.size, destinationRestricted: c.gatewayAllowlist != null,
      ...(clientServer ? { clientGatewayPort: clientServer.address()?.port } : {}) }),
    async stop() { closeAll(); await Promise.all(servers.map(closeServer)) },
  }
}
