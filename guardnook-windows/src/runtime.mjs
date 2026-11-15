import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { atomicJSON, readJSON } from './storage.mjs'

export async function createRuntime(serviceDirectory, directory) {
  const load = name => import(pathToFileURL(join(serviceDirectory, `${name}.mjs`)).href)
  const [{ validateConfig }, { createController }, { createGateway }, { createGuard }, { probeExit }, { createDiagnostics }, { createRouteCheck }, { createConnectionLog }, { closeClaudeConnections }, setup] = await Promise.all(
    ['config', 'controller', 'gateway', 'guard', 'probe', 'diagnostics', 'route-check', 'connection-log', 'tun-connections', 'setup'].map(load))
  let running, config, startError = null
  const statePath = join(directory, 'state.json')
  const stop = async () => {
    const previous = running
    running = undefined
    if (previous) {
      previous.diagnostics.stop()
      await previous.connectionLog.stop()
      await previous.guard.dispose()
      await previous.gateway.stop()
    }
  }
  const start = async () => {
    await stop()
    config = await readJSON(join(directory, 'config.json'), null)
    if (!config) return
    const c = validateConfig(config)
    if (c.targetPlatform !== 'win32' || c.serviceMode === 'existing' || c.ownedProtection) throw new Error('请重新保存 Windows 节点配置')
    const controller = createController(c)
    let guard
    const gateway = createGateway(c, event => guard.record(event), async () => { if (!await guard.admit()) throw new Error('Guard admission denied') })
    guard = createGuard(c, controller, gateway, probeExit, { drain: () => closeClaudeConnections(c, controller) })
    const diagnostics = createDiagnostics(c, controller)
    const routeCheck = createRouteCheck(c, controller, guard)
    const connectionLog = createConnectionLog(c, controller)
    try {
      await gateway.start()
      running = { c, controller, guard, gateway, diagnostics, routeCheck, connectionLog }
      const state = await readJSON(statePath, { manual: false })
      if (state.manual !== false) await guard.block()
      else if (c.startProtected) await guard.enable()
      guard.start(); diagnostics.start(); connectionLog.start()
      startError = null
    } catch (error) {
      await guard.dispose(); await gateway.stop(); running = undefined
      throw error
    }
  }
  return {
    async start() { try { await start() } catch (error) { startError = '守护未启动。请检查配置是否有效，以及网关端口是否被占用。'; throw error } },
    stop,
    settings: () => config ? Object.fromEntries(['expectedIP', 'selectedProxy', 'controllerURL', 'serverPort', 'clientPort', 'probePort', 'gatewayPort', 'startProtected', 'requireTun', 'guardGoogleAuth'].map(k => [k, config[k]]).concat([['hasSecret', !!config.controllerSecret]])) : null,
    status() { return running ? { ...running.guard.status(), connectionLog: running.connectionLog.status(), receivedAt: Date.now() } : { state: 'unconfigured', reason: startError, receivedAt: Date.now() } },
    async catalogue(input) {
      const previous = await readJSON(join(directory, 'config.json'), null)
      return setup.catalogue({ ...input, targetPlatform: 'win32', controllerSocket: '', controllerSecret: input.controllerSecret || previous?.controllerSecret || '' })
    },
    async save(input, originalScript) {
      const previous = await readJSON(join(directory, 'config.json'), null)
      if (originalScript === undefined) {
        const manifest = await readJSON(join(directory, 'SETUP.json'), null)
        if (manifest?.originalPath) {
          const { resolve, sep } = await import('node:path')
          const path = resolve(manifest.originalPath)
          if (!path.startsWith(resolve(directory, 'Profiles') + sep)) throw new Error('原始脚本路径无效')
          originalScript = await (await import('node:fs/promises')).readFile(path, 'utf8')
        }
      }
      const result = await setup.saveSetup(directory, { ...input, originalScript, controllerSocket: '', targetPlatform: 'win32', controllerSecret: input.controllerSecret || previous?.controllerSecret || '' })
      await start()
      return { ...result, settings: this.settings() }
    },
    async action(action) {
      if (!running) throw new Error('请先配置节点并启动守护')
      if (action === 'diagnostics') return running.diagnostics.status()
      if (action === 'audit') return running.diagnostics.inspect()
      if (action === 'route-check') return running.routeCheck.inspect()
      if (action === 'block') {
        const closing = running.guard.block()
        await atomicJSON(statePath, { manual: true })
        return closing
      }
      if (action === 'enable') {
        await atomicJSON(statePath, { manual: false })
        return running.guard.enable()
      }
      if (action === 'inspect') return running.guard.inspect()
      throw new Error('未知守护操作')
    },
  }
}
