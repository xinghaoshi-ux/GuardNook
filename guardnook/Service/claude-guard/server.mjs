import http from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { controllerOptions } from './controller.mjs'

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
// Never expose provider configs, passwords or the controller's arbitrary URL fetchers.
export function allowedRead(path) {
  return /^\/(?:version|configs|proxies|rules|connections|traffic|memory|logs)$/.test(path)
}
export function redactConfigs(value) {
  const safe = {}
  for (const key of ['mode', 'port', 'socks-port', 'mixed-port', 'allow-lan', 'log-level', 'ipv6', 'find-process-mode'])
    if (value[key] !== undefined) safe[key] = value[key]
  return safe
}

export async function createServer(c, guard, controller, staticDir, token, { diagnostics, routeCheck, connectionLog } = {}) {
  const root = await realpath(staticDir)
  const origin = `http://127.0.0.1:${c.serverPort}`
  const sockets = new Set()
  let mutation = Promise.resolve()
  const validRequest = req => req.headers.host === `127.0.0.1:${c.serverPort}`
    && (!req.headers.origin || req.headers.origin === origin)
    && !['cross-site'].includes(req.headers['sec-fetch-site'])
  const authorized = req => {
    const supplied = Buffer.from(req.headers['x-guard-token'] || '')
    const secret = Buffer.from(token)
    return supplied.length === secret.length && timingSafeEqual(supplied, secret)
      && req.headers.origin === origin && req.headers['content-type'] === 'application/json'
  }
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  const server = http.createServer(async (req, res) => {
    if (!validRequest(req)) { json(res, 403, { error: 'Local origin required' }); return }
    let url
    try { url = new URL(req.url, origin) } catch { json(res, 400, { error: 'Invalid path' }); return }
    try {
      if (url.pathname === '/api/claude-guard/status' && req.method === 'GET') {
        json(res, 200, { ...guard.status(), ...(connectionLog ? { connectionLog: connectionLog.status() } : {}) }); return
      }
      if (url.pathname === '/api/claude-guard/diagnostics' && req.method === 'GET' && !url.search && diagnostics) {
        json(res, 200, { ...diagnostics.status(), routeCheck: routeCheck?.status() }); return
      }
      if (url.pathname.startsWith('/api/claude-guard/')) {
        if (req.method !== 'POST' || !authorized(req)) { json(res, 403, { error: 'Authenticated local action required' }); return }
        const action = url.pathname.slice('/api/claude-guard/'.length)
        if (url.search || !['inspect', 'enable', 'block', 'audit', 'route-check'].includes(action)) { json(res, 404, { error: 'Unknown action' }); return }
        // Actions accept no arbitrary config, controller URL, exit IP or command.
        if (Number(req.headers['content-length'] || 0) > 2 || req.headers['transfer-encoding']) { json(res, 400, { error: 'Action accepts only an empty JSON object' }); return }
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 2) { json(res, 400, { error: 'Invalid body' }); return } }
        if (body !== '{}') { json(res, 400, { error: 'Invalid body' }); return }
        if (action === 'audit' && diagnostics) { json(res, 200, await diagnostics.inspect()); return }
        if (action === 'route-check' && routeCheck) { json(res, 200, await routeCheck.inspect()); return }
        if (['audit', 'route-check'].includes(action)) { json(res, 503, { error: 'Diagnostics unavailable' }); return }
        if (action === 'inspect') { json(res, 200, await guard.inspect()); return }
        const run = mutation.then(() => guard[action]())
        mutation = run.catch(() => {})
        json(res, 200, await run); return
      }
      if (url.pathname === '/api/control/info' && req.method === 'GET') { json(res, 200, { hasAgent: false }); return }
      if (url.pathname === '/proxy.pac' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' })
        const authHosts = [...(c.guardGoogleAuth === false ? [] : ['accounts.google.com', 'google.com', 'www.google.com']), 'anthropic.auth0.com', 'servd-anthropic-website.b-cdn.net', 'anthropic.com.cdn.cloudflare.net', 'anthropic-com.ghost.io']
        res.end(`function FindProxyForURL(url,host){host=host.toLowerCase();var domains=["claude.ai","claude.com","anthropic.com","claudeusercontent.com","claudemcpcontent.com","claudemcpclient.com","clau.de","hcaptcha.com","hcaptcha.net","challenges.cloudflare.com"];if(${JSON.stringify(authHosts)}.indexOf(host)!==-1)return "PROXY 127.0.0.1:${c.clientPort}";for(var i=0;i<domains.length;i++){if(host===domains[i]||host.slice(-domains[i].length-1)==="."+domains[i])return "PROXY 127.0.0.1:${c.clientPort}";}return "DIRECT";}`)
        return
      }
      if (url.pathname.startsWith('/api/mihomo/')) {
        const path = url.pathname.slice('/api/mihomo'.length)
        if (req.method !== 'GET' || !allowedRead(path) || url.search) { json(res, 403, { error: 'Guard dashboard exposes read-only controller data' }); return }
        const data = await controller.request(path)
        json(res, 200, path === '/configs' ? redactConfigs(data) : data); return
      }
      if (url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Unknown endpoint' }); return }
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Read only' }); return }
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
        res.end(`window.__METACUBEXD_CONFIG__ = ${JSON.stringify({ claudeGuard: true, guardToken: token, defaultBackendURL: `${origin}/api/mihomo` })};`); return
      }
      const decoded = decodeURIComponent(url.pathname)
      const candidate = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`)
      if (!candidate.startsWith(root + sep)) { json(res, 403, { error: 'Invalid file path' }); return }
      const path = await realpath(candidate)
      if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) { json(res, 403, { error: 'Invalid file path' }); return }
      res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
      res.end(req.method === 'HEAD' ? undefined : await readFile(path))
    } catch { json(res, 503, { error: 'Local resource or controller unavailable' }) }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url, origin) } catch { socket.destroy(); return }
    if (!validRequest(req) || req.headers.origin !== origin || req.method !== 'GET'
      || !['/api/mihomo/connections', '/api/mihomo/traffic', '/api/mihomo/memory', '/api/mihomo/logs'].includes(url.pathname)
      || (url.search && !(url.pathname.endsWith('/logs') && /^\?level=(?:info|warning|error|debug|silent)$/.test(url.search)))) { socket.destroy(); return }
    const upstream = http.request({ ...controllerOptions(c),
      path: url.pathname.slice('/api/mihomo'.length) + url.search, method: 'GET',
      headers: { ...controllerOptions(c).headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': req.headers['sec-websocket-key'],
        'sec-websocket-version': '13' } })
    upstream.on('upgrade', (res, peer, first) => {
      sockets.add(peer); peer.on('close', () => sockets.delete(peer)); peer.on('error', () => socket.destroy())
      if (socket.destroyed) { peer.destroy(); return }
      const headers = Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`)
      if (first.length) socket.write(first)
      if (head.length) peer.write(head)
      socket.pipe(peer).pipe(socket)
      socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy())
    })
    const deadline = setTimeout(() => upstream.destroy(), c.timeoutMs)
    upstream.on('upgrade', () => clearTimeout(deadline))
    upstream.on('response', () => { clearTimeout(deadline); socket.destroy(); upstream.destroy() })
    upstream.on('error', () => { clearTimeout(deadline); socket.destroy() })
    socket.on('error', () => upstream.destroy())
    upstream.end()
  })
  server.requestTimeout = 10000
  server.headersTimeout = 5000
  return {
    address: () => server.address(),
    start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.serverPort, '127.0.0.1', resolve) }),
    stop: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve) }),
  }
}
