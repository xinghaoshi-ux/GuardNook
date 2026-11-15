import { readFile, writeFile, mkdir, rename, cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { validateConfig } from './config.mjs'
import { createController } from './controller.mjs'
import { prepareSelectedProfile, applyClaudeGuard } from './profile.mjs'
import { coverageRules } from './coverage.mjs'
import { containClaude } from './containment.mjs'
import { applyCodexIntranet } from './codex-intranet.mjs'
import { verifyPolicy } from './guard.mjs'
import { applyPublicTun } from './public-tun.mjs'
import { tunRequiredRules } from './tun-connections.mjs'
import { wrapProfileScript } from './script-compat.mjs'

const atomic = async (path, data) => { await writeFile(path + '.guardnook-tmp', data, { mode: 0o600 }); await rename(path + '.guardnook-tmp', path) }
const yamlRead = path => JSON.parse(execFileSync('/usr/bin/ruby', ['-ryaml', '-rjson', '-e', 'print JSON.generate(YAML.load_file(ARGV[0]))', path], { encoding: 'utf8' }))
const yaml = value => execFileSync('/usr/bin/ruby', ['-ryaml', '-rjson', '-e', 'print YAML.dump(JSON.parse(STDIN.read))'], { input: JSON.stringify(value) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function composeOwnedScript(original, c, intranet) {
  const options = Object.fromEntries(['expectedIP', 'selectedProxy', 'pinnedProxy', 'policyGroup', 'gatewayProxy', 'clientPort', 'probePort', 'gatewayPort', 'proxyUser', 'proxyPassword', 'coverageVersion', 'frozenExitProxy', 'frozenSources', 'upstreamChain', 'upstreamBindings', 'ownedProtection', 'publicTunExit', 'publicProxyExit', 'requireTun', 'guardGoogleAuth', 'gatewayAllowlist', 'kernelProcessPath'].map(key => [key, c[key]]))
  const source = `const __ownedOriginalMain = (() => {\n${original}\nreturn main;\n})();\n`
    + `const coverageRules = ${coverageRules.toString()};\nconst tunRequiredRules = ${tunRequiredRules.toString()};\nconst __ownedPrepare = ${prepareSelectedProfile.toString()};\nconst __ownedApply = ${applyClaudeGuard.toString()};\nconst __ownedContain = ${containClaude.toString()};\nconst __ownedCodex = ${applyCodexIntranet.toString()};\n`
    + `function main(input) { const pristine=JSON.parse(JSON.stringify(input)); let value;\n`
    + `try { value=__ownedOriginalMain(JSON.parse(JSON.stringify(input))); } catch { value=pristine; }\n`
    + `try { value=__ownedApply(__ownedPrepare(value,${JSON.stringify(options)}),${JSON.stringify(options)}); } catch { value=__ownedContain(pristine); }\n`
    + (intranet ? `value=__ownedCodex(value,${JSON.stringify(intranet)});\n` : '')
    + (c.publicTunExit || c.publicProxyExit ? `value=(${applyPublicTun.toString()})(value,${JSON.stringify(options)},${4 + (c.guardGoogleAuth === false ? 0 : 3) + coverageRules(c).length + tunRequiredRules(c).length});\n` : '')
    + `return value; }\n`
  return wrapProfileScript(source)
}

export async function reconfigureOwned(root, candidate, node) {
  const home = homedir(), legacyRoot = join(home, 'Library/Application Support/ClaudeGuard')
  const previous = JSON.parse(await readFile(join(root, 'config.json')))
  const legacy = validateConfig(JSON.parse(await readFile(join(legacyRoot, 'config.json'))))
  if (previous.serviceMode !== 'existing' || previous.serverPort !== legacy.serverPort
    || candidate.controllerSocket !== legacy.controllerSocket || candidate.controllerURL !== legacy.controllerURL
    || candidate.controllerSecret !== legacy.controllerSecret) throw new Error('Existing service identity does not match')
  const install = JSON.parse(await readFile(join(legacyRoot, 'INSTALL.json')))
  if (!install.activated) throw new Error('Existing service is not owned')
  const base = join(home, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev')
  const runtimePath = join(base, 'clash-verge.yaml'), scriptPath = join(base, 'profiles/Script.js')
  if (install.profileScript !== scriptPath) throw new Error('Unexpected global script path')
  const frozen = Object.keys(node.upstreamBindings || {}).length > 0
  const c = validateConfig({ ...candidate, coverageVersion: 1, policyGroup: 'GuardNook-Claude', pinnedProxy: 'GuardNook-Pinned', pinnedEntry: 'GuardNook-Entry', gatewayProxy: 'GuardNook-Gateway',
    serverPort: legacy.serverPort, clientPort: legacy.clientPort, probePort: legacy.probePort, gatewayPort: legacy.gatewayPort,
    timeoutMs: legacy.timeoutMs, intervalMs: legacy.intervalMs, leaseMs: legacy.leaseMs, proxyPassword: legacy.proxyPassword,
    gatewayAllowlist: legacy.gatewayAllowlist, kernelProcessPath: legacy.kernelProcessPath,
    frozenExitProxy: frozen ? 'GuardNook-FrozenExit' : '', frozenSources: frozen ? [candidate.selectedProxy, ...node.upstreamChain] : [],
    upstreamBindings: node.upstreamBindings || {}, upstreamChain: frozen ? node.upstreamChain.map((_, i) => `GuardNook-FrozenUpstream-${i + 1}`) : node.upstreamChain,
    runtimePath, ownedProtection: true, publicTunExit: previous.publicTunExit === true || candidate.publicTunExit === true,
    publicProxyExit: previous.publicProxyExit === true || candidate.publicProxyExit === true,
    requireTun: previous.requireTun === true || candidate.requireTun === true,
    guardGoogleAuth: previous.guardGoogleAuth === false ? false : candidate.guardGoogleAuth !== false })
  let intranet = null
  try { intranet = JSON.parse(await readFile(join(root, 'codex-intranet.json'))) } catch {}
  const originalRuntime = await readFile(runtimePath), current = yamlRead(runtimePath)
  // The first reconfiguration saves a pristine extension for subsequent IP changes.
  let originalScript
  try { originalScript = await readFile(join(root, 'owned-original-Script.js'), 'utf8') }
  catch {
    const currentScript = await readFile(scriptPath, 'utf8')
    originalScript = currentScript.includes('__beforeGuardNookContainment') ? currentScript.slice(0, currentScript.indexOf('\nconst __beforeGuardNookContainment')) : currentScript
  }
  // Remove only our managed nodes/rules when reconfiguring; leave ordinary nodes.
  const names = new Set([legacy.pinnedProxy, legacy.gatewayProxy, legacy.policyGroup, 'GuardNook-Pinned', 'GuardNook-Gateway', 'GuardNook-Claude', 'GuardNook-FrozenExit', ...(legacy.upstreamChain || []).filter(n => n.startsWith('GuardNook-Frozen'))])
  const clean = { ...current, proxies: (current.proxies || []).filter(p => !names.has(p.name)), 'proxy-groups': (current['proxy-groups'] || []).filter(p => !names.has(p.name)),
    listeners: (current.listeners || []).filter(l => ![c.clientPort, c.probePort].includes(l.port)),
    rules: (current.rules || []).filter(r => ![...names].some(n => r.endsWith(',' + n)) && !containClaude({}).rules.includes(r)) }
  let prepared = applyClaudeGuard(prepareSelectedProfile(clean, c), c)
  if (intranet) prepared = applyCodexIntranet(prepared, intranet)
  prepared = applyPublicTun(prepared, c, 4 + (c.guardGoogleAuth === false ? 0 : 3) + coverageRules(c).length + tunRequiredRules(c).length)
  const source = composeOwnedScript(originalScript, c, intranet); new Script(source)
  const backup = join(root, 'Backups/owned-reconfigure-' + Date.now()); await mkdir(backup, { recursive: true, mode: 0o700 })
  await cp(join(legacyRoot, 'lib'), join(backup, 'lib'), { recursive: true })
  for (const [name, path] of [['runtime.yaml', runtimePath], ['Script.js', scriptPath], ['legacy-config.json', join(legacyRoot, 'config.json')], ['panel-config.json', join(root, 'config.json')], ['state.json', join(legacyRoot, 'state.json')]]) {
    try { await cp(path, join(backup, name)); await execFileSync('/bin/chmod', ['600', join(backup, name)]) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  const candidatePath = join(backup, 'candidate.yaml'); await writeFile(candidatePath, yaml(prepared), { mode: 0o600 })
  execFileSync('/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo', ['-t', '-f', candidatePath, '-d', base], { stdio: 'pipe', timeout: 15000 })
  const ctl = createController(legacy)
  // Close the live gate before changing either configuration or rules.
  const origin = `http://127.0.0.1:${legacy.serverPort}`
  const info = await fetch(origin + '/config.js', { signal: AbortSignal.timeout(3000) }).then(r => r.text())
  const token = JSON.parse(info.slice(info.indexOf('=') + 1).trim().replace(/;$/, '')).guardToken
  const response = await fetch(origin + '/api/claude-guard/block', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-guard-token': token }, body: '{}', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Could not close the previous guard')
  await atomic(join(root, 'owned-original-Script.js'), originalScript)
  await atomic(scriptPath, source); await atomic(runtimePath, yaml(prepared))
  await ctl.request('/configs?force=true', 'PUT', { path: runtimePath })
  const [configs, proxies, rules] = await Promise.all(['/configs', '/proxies', '/rules'].map(p => ctl.request(p))); verifyPolicy({ configs, proxies, rules }, c)
  await cp(fileURLToPath(new URL('.', import.meta.url)), join(legacyRoot, 'lib'), { recursive: true, force: true })
  await atomic(join(legacyRoot, 'config.json'), JSON.stringify(c, null, 2) + '\n')
  const attached = { ...c, serviceMode: 'existing', startProtected: false }; delete attached.proxyPassword
  await atomic(join(root, 'config.json'), JSON.stringify(attached, null, 2) + '\n')
  // The manual latch deliberately remains set: saving a new target does not allow it.
  execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/local.claude-egress-guard`], { stdio: 'pipe' })
  for (let i = 0; i < 40; i++) {
    try { const status = await fetch(origin + '/api/claude-guard/status', { signal: AbortSignal.timeout(500) }).then(r => r.json()); if (status.expectedIP === c.expectedIP && status.manual === true && status.gateway?.open === false) return { saved: true, reusedExistingGuard: true, reconfiguredExistingGuard: true, serverPort: c.serverPort, expectedIP: c.expectedIP, selectedProxy: c.selectedProxy } } catch {}
    await sleep(250)
  }
  throw new Error('Configuration saved blocked; service restart not confirmed')
}
