import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_CONFIG } from './config.mjs'
import { createGateway } from './gateway.mjs'
import { connectTunnel, proxyAuthorization } from './tunnel.mjs'
import { createServer } from './server.mjs'

test('gateway rejects unauthenticated/closed requests, expiry cuts existing tunnels', async t => {
  const upstream = http.createServer()
  upstream.on('connect', (_req, socket) => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); socket.on('data', chunk => socket.write(chunk)); socket.on('end', () => socket.end()) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const c = { ...DEFAULT_CONFIG, proxyPassword: 'a'.repeat(64), gatewayPort: 0, probePort: upstream.address().port, leaseMs: 500 }
  const gateway = createGateway(c)
  await gateway.start()
  t.after(async () => { await gateway.stop(); await new Promise(resolve => upstream.close(resolve)) })
  const port = gateway.address().port
  await assert.rejects(connectTunnel(c, 'claude.ai:443', port))
  gateway.grant(Date.now() + 350)
  await assert.rejects(connectTunnel({ ...c, proxyPassword: '' }, 'claude.ai:443', port))
  const tunnel = await connectTunnel(c, 'claude.ai:443', port)
  tunnel.resume(); tunnel.write('hello')
  assert.equal((await once(tunnel, 'data'))[0].toString(), 'hello')
  await once(tunnel, 'close')
  assert.equal(gateway.status().open, false)
  await assert.rejects(connectTunnel(c, 'claude.ai:443', port))
})
test('expiry during pending CONNECT never permits a late upstream success', async () => {
  const upstream = http.createServer()
  upstream.on('connect', (_req, socket) => { setTimeout(() => socket.end('HTTP/1.1 200 OK\r\n\r\n'), 160); socket.on('error', () => {}) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const c = { ...DEFAULT_CONFIG, proxyPassword: 'a'.repeat(64), gatewayPort: 0, probePort: upstream.address().port, leaseMs: 100 }
  const gateway = createGateway(c); await gateway.start(); gateway.grant(Date.now() + 50)
  const socket = net.createConnection({ host: '127.0.0.1', port: gateway.address().port })
  let received = ''; socket.on('data', x => received += x.toString())
  await once(socket, 'connect'); socket.write(`CONNECT claude.ai:443 HTTP/1.1\r\nProxy-Authorization: ${proxyAuthorization(c)}\r\n\r\n`)
  await once(socket, 'close')
  assert.ok(!received.includes('200'))
  await gateway.stop(); await new Promise(resolve => upstream.close(resolve))
})
test('dashboard blocks cross-origin actions, controller mutations, config secrets and symlink escapes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-guard-test-'))
  await writeFile(join(dir, 'index.html'), '<html>guard</html>')
  const outside = await mkdtemp(join(tmpdir(), 'claude-guard-outside-'))
  await writeFile(join(outside, 'secret'), 'never expose')
  await symlink(join(outside, 'secret'), join(dir, 'escape'))
  const c = { ...DEFAULT_CONFIG, serverPort: 0, guardGoogleAuth: false }
  const calls = []
  const guard = { status: () => ({ state: 'observe' }), block: async () => { calls.push('block'); return {} } }
  const controller = { request: async path => { calls.push(path); return { mode: 'rule', secret: 'secret', authentication: ['secret'] } } }
  // Server uses exact configured Host: allocate first, then configure the real port.
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
  c.serverPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const diagnostics = { status: () => ({ state: 'unknown' }), inspect: async () => { calls.push('audit'); return {} } }
  const routeCheck = { status: () => ({ state: 'not-tested' }), inspect: async () => { calls.push('route-check'); return {} } }
  const server = await createServer(c, guard, controller, dir, 'token', { diagnostics, routeCheck })
  await server.start()
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true }); await rm(outside, { recursive: true }) })
  const base = `http://127.0.0.1:${c.serverPort}`
  const request = (path, opts = {}) => fetch(base + path, opts)
  const pac = await (await request('/proxy.pac')).text()
  const route = runInNewContext(pac + '\nFindProxyForURL')
  for (const host of ['google.com', 'www.google.com', 'accounts.google.com']) assert.equal(route('https://' + host + '/', host), 'DIRECT')
  for (const host of ['claude.ai', 'api.anthropic.com', 'anthropic.auth0.com']) assert.equal(route('https://' + host + '/', host), 'PROXY 127.0.0.1:' + c.clientPort)
  assert.equal((await request('/api/claude-guard/block', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json', 'x-guard-token': 'token' }, body: '{}' })).status, 403)
  assert.equal((await request('/api/claude-guard/block', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 403)
  assert.equal((await request('/api/claude-guard/block', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-guard-token': 'token' }, body: '{}' })).status, 200)
  assert.equal((await request('/api/mihomo/configs', { method: 'PATCH', body: '{}' })).status, 403)
  assert.equal((await request('/api/mihomo/providers/proxies')).status, 403)
  assert.equal((await request('/api/claude-guard/route-check', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json', 'x-guard-token': 'token' }, body: '{}' })).status, 403)
  assert.equal((await request('/api/claude-guard/route-check', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-guard-token': 'token' }, body: '{"host":"internal"}' })).status, 400)
  for (const name of ['audit', 'route-check']) assert.equal((await request(`/api/claude-guard/${name}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-guard-token': 'token' }, body: '{}' })).status, 200)
  assert.equal((await request('/api/claude-guard/route-check?url=http://internal', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-guard-token': 'token' }, body: '{}' })).status, 404)
  assert.equal((await request('/api/claude-guard/diagnostics')).status, 200)
  assert.deepEqual(await (await request('/api/mihomo/configs')).json(), { mode: 'rule' })
  assert.equal((await request('/escape')).status, 403)
  const invalidHost = await new Promise(resolve => {
    http.get(base + '/api/claude-guard/status', { headers: { host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode) })
  })
  assert.equal(invalidHost, 403)
  assert.deepEqual(calls, ['block', 'audit', 'route-check', '/configs'])
})
