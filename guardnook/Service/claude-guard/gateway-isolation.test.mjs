import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { validateConfig } from './config.mjs'
import { createGateway, gatewayDestinationAllowed } from './gateway.mjs'
import { connectTunnel, proxyAuthorization } from './tunnel.mjs'

test('restricted gateway permits only HTTPS on configured service domains', () => {
  const c = validateConfig({ gatewayAllowlist: ['claude.ai'] })
  for (const host of ['claude.ai', 'api.claude.ai', 'CLAUDE.AI.'])
    assert.equal(gatewayDestinationAllowed(c, host, 443), true, host)
  for (const host of ['localhost', 'service.localhost', 'intranet', 'portal.corp.example.com',
    '<IP>', '127.0.0.1', '<IP>', '<IP>', '<IP>', '[::1]',
    '[fd00::1]', 'claude.ai.attacker.test', 'notclaude.ai'])
    assert.equal(gatewayDestinationAllowed(c, host, 443), false, host)
  for (const port of [22, 53, 80, 445, 7897, 17903])
    assert.equal(gatewayDestinationAllowed(c, 'claude.ai', port), false)
  assert.equal(gatewayDestinationAllowed(validateConfig({ gatewayAllowlist: [] }), 'claude.ai', 443), false)
  for (const value of ['*', ['*'], ['127.0.0.1'], ['localhost'], ['service.local'], ['https://claude.ai']])
    assert.throws(() => validateConfig({ gatewayAllowlist: value }))
})

test('denied HTTP and CONNECT destinations never reach upstream, even with an open lease', async t => {
  let upstreamCalls = 0, admissions = 0
  const upstream = http.createServer((_req, res) => { upstreamCalls++; res.end('upstream') })
  upstream.on('connect', (_req, socket) => {
    upstreamCalls++; socket.write('HTTP/1.1 200 OK\r\n\r\n')
    socket.on('data', chunk => socket.write(chunk)); socket.on('end', () => socket.end())
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const c = { ...validateConfig({ gatewayAllowlist: ['claude.ai'], proxyPassword: 'a'.repeat(64) }),
    ownedProtection: true, gatewayPort: 0, clientPort: 0, probePort: upstream.address().port }
  const gateway = createGateway(c, () => {}, async () => { admissions++ })
  await gateway.start(); gateway.grant(Date.now() + 15000)
  t.after(async () => { await gateway.stop(); await new Promise(resolve => upstream.close(resolve)) })
  const port = gateway.address().port
  const request = path => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path,
      headers: { 'proxy-authorization': proxyAuthorization(c) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    }); req.on('error', reject)
  })
  for (const path of ['http://127.0.0.1:12345/', 'http://<IP>/',
    'http://portal.corp.example.com/', 'http://2130706433/', 'http://[::1]/'])
    assert.equal(await request(path), 403, path)
  for (const host of ['127.0.0.1:443', '<IP>:443', 'portal.corp.example.com:443', '[::1]:443']) {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    await once(socket, 'connect')
    let response = ''; socket.on('data', data => response += data)
    socket.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: ${proxyAuthorization(c)}\r\n\r\n`)
    await once(socket, 'close'); assert.match(response, /^HTTP\/1.1 403/)
  }
  assert.equal(upstreamCalls, 0); assert.equal(admissions, 0)
  const clientPort = gateway.clientAddress().port
  const refused = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: clientPort, path: 'http://127.0.0.1:12345/' }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    }); req.on('error', reject)
  })
  assert.equal(refused, 403)
  assert.equal(upstreamCalls, 0)
  const tunnel = await connectTunnel(c, 'claude.ai:443', port)
  tunnel.resume(); tunnel.write('allowed')
  assert.equal((await once(tunnel, 'data'))[0].toString(), 'allowed')
  tunnel.destroy()
  assert.equal(upstreamCalls, 1); assert.equal(admissions, 1)
  // The public Claude entrance shares the same filter, lease and authenticated
  // upstream. It does not go through the general system proxy's DIRECT rules.
  const publicTunnel = await connectTunnel({ ...c, proxyPassword: '' }, 'claude.ai:443', clientPort)
  publicTunnel.resume(); publicTunnel.write('filtered')
  assert.equal((await once(publicTunnel, 'data'))[0].toString(), 'filtered')
  gateway.closeAll()
  await assert.rejects(connectTunnel({ ...c, proxyPassword: '' }, 'claude.ai:443', clientPort))
  assert.equal(upstreamCalls, 2)
  assert.equal(gateway.status().destinationRestricted, true)
})
