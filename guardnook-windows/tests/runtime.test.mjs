import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRuntime } from '../src/runtime.mjs'
import { portableConfig } from '../../guardnook/Service/claude-guard/setup.mjs'

const freePort = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
test('Windows runtime stays closed when TUN is off and persists manual block through restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guardnook-runtime-'))
  const controller = createServer((req, res) => {
    const value = req.url === '/configs' ? { mode: 'rule', tun: { enable: false } }
      : req.url === '/proxies' ? { proxies: {} } : req.url === '/rules' ? { rules: [] } : { connections: [] }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
  })
  controller.listen(0, '127.0.0.1'); await once(controller, 'listening')
  let runtime
  try {
    const ports = new Set()
    while (ports.size < 4) ports.add(await freePort())
    const [serverPort, clientPort, probePort, gatewayPort] = [...ports]
    const config = portableConfig({ targetPlatform: 'win32', controllerSocket: '', controllerURL: `http://127.0.0.1:${controller.address().port}`, expectedIP: '<IP>', selectedProxy: 'fixed', requireTun: true, serverPort, clientPort, probePort, gatewayPort }, 'a'.repeat(64))
    await writeFile(join(directory, 'config.json'), JSON.stringify(config))
    runtime = await createRuntime(resolve('apps/guardnook/Service/claude-guard'), directory)
    await runtime.start()
    const enabled = await runtime.action('enable')
    assert.equal(enabled.gateway.open, false)
    assert.equal(enabled.reason, 'tun-required')
    await runtime.action('block')
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'))).manual, true)
    await runtime.stop(); await runtime.start()
    assert.equal(runtime.status().manual, true)
    assert.equal(runtime.status().gateway.open, false)
    assert.equal(runtime.settings().expectedIP, '<IP>')
    assert.equal(Object.hasOwn(runtime.settings(), 'proxyPassword'), false)
    assert.equal(Object.hasOwn(runtime.settings(), 'controllerSecret'), false)
    await assert.rejects(runtime.action('arbitrary-command'))
  } finally {
    await runtime?.stop()
    controller.closeAllConnections(); await new Promise(resolve => controller.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
