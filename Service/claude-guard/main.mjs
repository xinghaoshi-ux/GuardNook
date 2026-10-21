import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './entry.mjs'
import { validateConfig } from './config.mjs'
import { createController } from './controller.mjs'
import { probeExit } from './probe.mjs'
import { createGateway } from './gateway.mjs'
import { createGuard } from './guard.mjs'
import { createServer } from './server.mjs'
import { createDiagnostics } from './diagnostics.mjs'
import { createRouteCheck } from './route-check.mjs'
import { createConnectionLog } from './connection-log.mjs'
import { createContainmentRepair } from './enforcement.mjs'
import { closeClaudeConnections } from './tun-connections.mjs'

export async function main(args = process.argv.slice(2)) {
  const configArg = args.indexOf('--config')
  const input = configArg >= 0 ? JSON.parse(await readFile(args[configArg + 1], 'utf8')) : {}
  const c = validateConfig(input)
  const controller = createController(c)
  let guard
  const gateway = createGateway(c, event => guard.record(event), async () => {
    if (!await guard.admit()) throw new Error('Guard admission denied')
  })
  guard = createGuard(c, controller, gateway, probeExit, {
    contain: createContainmentRepair(c, controller), drain: () => closeClaudeConnections(c, controller),
  })
  // Manual blocking survives launchd restarts; malformed saved state is blocked.
  const statePath = configArg >= 0 ? join(dirname(resolve(args[configArg + 1])), 'state.json') : null
  let savedManual = false
  if (statePath) {
    try { const saved = JSON.parse(await readFile(statePath, 'utf8')); savedManual = saved.manual !== false }
    catch (error) { if (error.code !== 'ENOENT') savedManual = true }
    const persist = async manual => {
      const temporary = `${statePath}.${randomBytes(8).toString('hex')}.tmp`
      await writeFile(temporary, JSON.stringify({ manual }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, statePath)
    }
    const enable = guard.enable, block = guard.block
    guard.enable = async () => { await persist(false); return enable() }
    guard.block = async () => {
      // Set the in-memory latch before I/O so a disk failure cannot reopen it.
      const closing = block()
      try { await persist(true) } catch { await closing; throw new Error('Block persistence unavailable') }
      return closing
    }
  }
  const staticArg = args.indexOf('--static')
  const staticDir = staticArg >= 0 ? args[staticArg + 1] : fileURLToPath(new URL('../../packages/ui/.output/public', import.meta.url))
  const diagnostics = createDiagnostics(c, controller)
  const routeCheck = createRouteCheck(c, controller, guard)
  const connectionLog = createConnectionLog(c, controller)
  const server = await createServer(c, guard, controller, staticDir, randomBytes(32).toString('hex'), { diagnostics, routeCheck, connectionLog })
  await gateway.start()
  try { await server.start() } catch (error) { await gateway.stop(); throw error }
  if (args.includes('--enforce')) {
    if (savedManual) await guard.block()
    else await guard.enable()
  }
  guard.start()
  diagnostics.start()
  connectionLog.start()
  console.log(`Claude Guard: http://127.0.0.1:${c.serverPort}/#/claude-guard`)
  console.log(args.includes('--enforce') ? 'Enforcement requested; inspect dashboard for verified state.' : 'Observation only; live routing unchanged.')
  let stopping = false
  let parentTimer
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(parentTimer)
    diagnostics.stop()
    await connectionLog.stop()
    await guard.dispose()
    await Promise.all([server.stop(), gateway.stop()])
  }
  const parentArg = args.indexOf('--parent-pid')
  if (parentArg >= 0) {
    const parentPID = Number(args[parentArg + 1])
    if (!Number.isInteger(parentPID) || parentPID <= 1) { await shutdown(); throw new Error('Invalid parent PID') }
    parentTimer = setInterval(() => {
      try { process.kill(parentPID, 0) }
      catch { void shutdown() }
    }, 1000)
    parentTimer.unref()
  }
  return { c, guard, shutdown }
}

if (isMainModule(import.meta.url)) {
  main().then(({ shutdown }) => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void shutdown().finally(() => process.exit(0)))
  }).catch(() => { console.error('Claude Guard could not start. Check local configuration and port availability.'); process.exit(1) })
}
