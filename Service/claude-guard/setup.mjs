import { mkdir, readFile, writeFile, rename, lstat, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './entry.mjs'
import { Script } from 'node:vm'
import { validateConfig, DEFAULT_CONFIG } from './config.mjs'
import { createController } from './controller.mjs'
import { composeProfileScript } from './profile.mjs'
import { verifyPolicy } from './guard.mjs'
import { reconfigureOwned } from './owned.mjs'
import { clientAdapter, localEndpoints } from './clients.mjs'
import { measureSetup, verifySetupConfirmation } from './setup-probe.mjs'

export const PORTABLE_DEFAULTS = Object.freeze({
  targetPlatform: 'darwin', requireTun: false, guardGoogleAuth: true, clientID: 'verge',
  controllerSocket: DEFAULT_CONFIG.controllerSocket, controllerURL: '', controllerSecret: '',
  expectedIP: '', selectedProxy: '', upstreamChain: [],
  policyGroup: 'GuardNook-Claude', pinnedProxy: 'GuardNook-Pinned', pinnedEntry: 'GuardNook-Entry',
  gatewayProxy: 'GuardNook-Gateway', serverPort: 18791, clientPort: 18901, probePort: 18903, gatewayPort: 18904,
})
const types = new Set(['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'PassRule', 'Dns', 'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])
export function resolveUpstreamChain(snapshot, selected) {
  const chain = [], bindings = {}, seen = new Set()
  let name = selected
  while (name) {
    if (['DIRECT', 'REJECT', 'GLOBAL', 'Claude-guard-gateway', PORTABLE_DEFAULTS.gatewayProxy].includes(name))
      throw new Error('Upstream cannot be a bypass or guard gateway')
    if (seen.has(name)) throw new Error('Cyclic upstream chain')
    seen.add(name)
    const node = snapshot?.proxies?.[name]
    if (name !== selected && node?.type === 'Selector' && Array.isArray(node.all)) {
      if (typeof node.now !== 'string' || !node.all.includes(node.now)) throw new Error('Upstream selector has no concrete selection')
      bindings[name] = node.now
      name = node.now
      continue
    }
    if (!node || typeof node.type !== 'string' || types.has(node.type) || Array.isArray(node.all))
      throw new Error('Upstream must be a concrete node')
    if (name !== selected) chain.push(name)
    const next = node['dialer-proxy']
    if (next === undefined || next === '') break
    if (typeof next !== 'string' || !next || /[\r\n,\0]/.test(next) || chain.length >= 8)
      throw new Error('Invalid upstream chain')
    name = next
  }
  return { upstreamChain: chain, upstreamBindings: bindings }
}
export function detectUpstreamChain(snapshot, selected) {
  return resolveUpstreamChain(snapshot, selected).upstreamChain
}
export function nodeCatalogue(snapshot) {
  return Object.entries(snapshot?.proxies || {}).flatMap(([name, node]) => {
    if (!name || name.startsWith('GuardNook-Frozen') || /[\r\n,\0]/.test(name) || ['DIRECT', 'REJECT', 'GLOBAL', 'COMPATIBLE', 'Claude-guard-gateway', PORTABLE_DEFAULTS.gatewayProxy].includes(name)
      || !node || typeof node.type !== 'string' || types.has(node.type) || Array.isArray(node.all)) return []
    try {
      const resolved = resolveUpstreamChain(snapshot, name)
      return [{ name, type: node.type, udp: node.udp === true, upstreamChain: resolved.upstreamChain,
        ...(Object.keys(resolved.upstreamBindings).length ? { upstreamBindings: resolved.upstreamBindings } : {}) }]
    }
    catch { return [{ name, type: node.type, udp: node.udp === true, upstreamChain: [], chainError: '上游链路包含自动切换组、缺失节点或循环，请选择固定的具体链路。' }] }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
export function portableConfig(input, password) {
  if (input.startProtected !== undefined && typeof input.startProtected !== 'boolean') throw new Error('Invalid startup preference')
  const fields = {}
  for (const key of Object.keys(PORTABLE_DEFAULTS)) if (input[key] !== undefined) fields[key] = input[key]
  return validateConfig({ ...PORTABLE_DEFAULTS, ...fields, startProtected: input.startProtected === true, proxyPassword: password })
}
export async function catalogue(input) {
  // Reading a catalogue does not verify or select any route.
  const c = portableConfig({ ...input, expectedIP: input.expectedIP || '203.0.113.1', selectedProxy: '' }, '')
  const controller = createController(c)
  const [version, snapshot] = await Promise.all([controller.request('/version'), controller.request('/proxies')])
  if (typeof version?.version !== 'string' || !snapshot?.proxies || typeof snapshot.proxies !== 'object')
    throw new Error('Not a Clash controller')
  const adapter = clientAdapter(input.clientID || 'verge')
  return { clientID: adapter.id, clientTitle: adapter.title, integration: adapter.support, persistentTun: adapter.persistentTun, version: version.version, nodes: nodeCatalogue(snapshot) }
}
export async function discover(input, readCatalogue = catalogue) {
  // Only known local endpoints; no config files, passwords, routes or selectors are changed.
  // A user-supplied credential belongs to the explicitly selected endpoint.
  // Never broadcast it across automatic discovery candidates.
  if (input.controllerSecret) return { ...await readCatalogue(input), controllerSocket: input.controllerSocket || '', controllerURL: input.controllerURL || '', clientID: input.clientID || 'verge' }
  const endpoints = await localEndpoints(input)
  // Preserve the legacy discovery ordering for existing integrations and tests.
  if (!input.clientID) endpoints.splice(0, endpoints.length,
    { controllerSocket: PORTABLE_DEFAULTS.controllerSocket, controllerURL: '' },
    { controllerSocket: '', controllerURL: 'http://127.0.0.1:9090' })
  for (const endpoint of endpoints) {
    try { return { ...await readCatalogue({ ...input, ...endpoint }), ...endpoint } } catch {}
  }
  throw new Error('No local Clash controller found')
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration directory must not be a symlink')
  await chmod(path, 0o700)
}
async function atomicPrivate(path, data) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private configuration must be a regular file') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp'
  await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
export async function findExistingGuard(root, candidate) {
  try {
    const legacy = validateConfig(JSON.parse(await readFile(join(dirname(root), 'ClaudeGuard/config.json'), 'utf8')))
    if (legacy.requireTun !== candidate.requireTun || legacy.expectedIP !== candidate.expectedIP || legacy.pinnedProxy !== candidate.selectedProxy
      || legacy.controllerURL !== candidate.controllerURL || legacy.controllerSocket !== candidate.controllerSocket
      || legacy.controllerSecret !== candidate.controllerSecret) return null
    const controller = createController(legacy)
    const [configs, proxies, rules] = await Promise.all(['/configs', '/proxies', '/rules'].map(path => controller.request(path)))
    verifyPolicy({ configs, proxies, rules }, legacy)
    const origin = `http://127.0.0.1:${legacy.serverPort}`
    const get = async path => {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(3000), redirect: 'error' })
      if (!response.ok) throw new Error('Existing service unavailable')
      return response.json()
    }
    const [status, relay] = await Promise.all([get('/api/claude-guard/status'), get('/api/mihomo/proxies')])
    if (status.expectedIP !== candidate.expectedIP || typeof status.enabled !== 'boolean'
      || status.policyGroup && status.policyGroup !== legacy.policyGroup
      || JSON.stringify(relay.proxies?.[legacy.policyGroup]?.all) !== JSON.stringify(proxies.proxies?.[legacy.policyGroup]?.all)
      || !relay.proxies?.[legacy.pinnedProxy] || relay.proxies?.[legacy.gatewayProxy]?.type !== 'Http') return null
    return { legacy, status }
  } catch { return null }
}
export async function saveSetup(root, input, readCatalogue = catalogue) {
  clientAdapter(input.clientID || 'verge')
  let previous
  try { previous = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing configuration is unreadable; it was preserved') }
  let c = portableConfig(input, previous?.proxyPassword || randomBytes(32).toString('hex'))
  if (!c.selectedProxy) throw new Error('Choose a Clash node first')
  const [a, b] = c.expectedIP.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127)
    throw new Error('Expected exit must be a public IPv4 address')
  const { nodes } = await readCatalogue(c)
  let node = nodes.find(n => n.name === c.selectedProxy)
  if (!node) throw new Error('Selected node is no longer available')
  if (node.chainError) throw new Error('Selected node has an unsafe upstream chain')
  if (input.fixedUpstreams && Object.keys(input.fixedUpstreams).length) {
    const entries = Object.entries(input.fixedUpstreams)
    if (entries.length !== 1) throw new Error('Choose one concrete first upstream')
    const [group, name] = entries[0], upstream = nodes.find(n => n.name === name)
    if (!Object.hasOwn(node.upstreamBindings || {}, group) || !upstream || upstream.chainError || name === c.selectedProxy
      || node.upstreamChain[0] !== node.upstreamBindings[group] || upstream.upstreamChain.includes(c.selectedProxy)) throw new Error('Invalid fixed upstream choice')
    node = { ...node, upstreamChain: [name, ...upstream.upstreamChain], upstreamBindings: { ...upstream.upstreamBindings, [group]: name } }
  }
  await verifySetupConfirmation(root, { ...input, resolvedUpstream: node.upstreamChain || [] })
  c = portableConfig({ ...c, upstreamChain: [...new Set([...(node.upstreamChain || []), ...c.upstreamChain])] }, c.proxyPassword)
  const existing = c.targetPlatform === 'win32' ? null : await findExistingGuard(root, c)
  if (existing) {
    const { legacy } = existing
    // Attach to the already-installed service. Never launch a duplicate gateway,
    // rewrite its profile, change its enabled/manual state, or copy its password.
    const attached = { ...c, serviceMode: 'existing', serverPort: legacy.serverPort,
      coverageVersion: legacy.coverageVersion || 0,
      policyGroup: legacy.policyGroup, pinnedProxy: legacy.pinnedProxy, gatewayProxy: legacy.gatewayProxy,
      startProtected: false }
    delete attached.proxyPassword
    await privateDirectory(root)
    await atomicPrivate(join(root, 'SETUP.json'), JSON.stringify({ version: 2, configuredAt: Date.now(), serviceMode: 'existing' }, null, 2))
    await atomicPrivate(join(root, 'config.json'), JSON.stringify(attached, null, 2))
    return { saved: true, reusedExistingGuard: true, serverPort: legacy.serverPort, expectedIP: c.expectedIP, selectedProxy: c.selectedProxy }
  }
  if (previous?.serviceMode === 'existing') return reconfigureOwned(root, c, node)
  // Never read a script from a path supplied by a web request. The native file
  // picker sends the chosen text over a private stdin pipe.
  const original = typeof input.originalScript === 'string' && input.originalScript.trim()
    ? input.originalScript : 'function main(config) { return config; }'
  if (original.length > 2 * 1024 * 1024) throw new Error('Clash script is too large')
  c = { ...c, coverageVersion: 1 }
  if (Object.keys(node.upstreamBindings || {}).length) {
    c = validateConfig({ ...c, frozenExitProxy: 'GuardNook-FrozenExit', frozenSources: [c.selectedProxy, ...node.upstreamChain],
      upstreamBindings: node.upstreamBindings,
      upstreamChain: node.upstreamChain.map((_, i) => `GuardNook-FrozenUpstream-${i + 1}`) })
  }
  const script = composeProfileScript(original, c)
  new Script(script) // Parse only; do not execute a user's Clash extension here.
  await privateDirectory(root)
  await privateDirectory(join(root, 'Profiles'))
  const generation = join(root, 'Profiles', new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex'))
  await privateDirectory(generation)
  await writeFile(join(generation, 'original.js'), original, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generation, 'GuardNook-Clash.js'), script, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generation, 'config.json'), JSON.stringify(c, null, 2), { mode: 0o600, flag: 'wx' })
  const manifest = { version: 1, configuredAt: Date.now(), scriptPath: join(generation, 'GuardNook-Clash.js'), originalPath: join(generation, 'original.js') }
  await atomicPrivate(join(root, 'SETUP.json'), JSON.stringify(manifest, null, 2))
  // Both generated files already exist when the active configuration changes.
  await atomicPrivate(join(root, 'config.json'), JSON.stringify(c, null, 2))
  return { saved: true, scriptPath: manifest.scriptPath, serverPort: c.serverPort, expectedIP: c.expectedIP, selectedProxy: c.selectedProxy }
}
async function command() {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > 3 * 1024 * 1024) throw new Error('Setup request too large')
  }
  const input = JSON.parse(text)
  if (input.operation === 'catalogue') return catalogue(input)
  if (input.operation === 'discover') return discover(input)
  if (input.operation === 'measure') {
    const c = portableConfig({ ...input, expectedIP: '203.0.113.1' }, '')
    const { nodes } = await catalogue(c)
    if (!nodes.some(node => node.name === c.selectedProxy && !node.chainError)) throw new Error('请选择可用的固定节点。')
    const node = nodes.find(node => node.name === c.selectedProxy)
    return measureSetup(join(homedir(), 'Library/Application Support/GuardNook'), { ...input, resolvedUpstream: node.upstreamChain || [] }, createController(c))
  }
  if (input.operation === 'monitor') {
    const root = join(homedir(), 'Library/Application Support/GuardNook')
    try { await lstat(join(root, 'config.json')); throw new Error('已有守护配置，请保留原保护或先撤销接入。') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await privateDirectory(root)
    await atomicPrivate(join(root, 'monitor.json'), JSON.stringify({ version: 1, mode: 'monitor', at: Date.now() }))
    return { saved: true, monitoring: true }
  }
  if (input.operation === 'save') return saveSetup(join(homedir(), 'Library/Application Support/GuardNook'), input)
  throw new Error('Unknown setup operation')
}
if (isMainModule(import.meta.url)) {
  command().then(result => console.log(JSON.stringify(result))).catch(error => {
    // No raw error, request, auth header or proxy configuration on stdout/stderr.
    const message = String(error.message || '')
    console.log(JSON.stringify({ error: /[\u4e00-\u9fff]/.test(message) && message.length < 350 && !/https?:|Bearer|password|secret/i.test(message) ? message : '无法完成配置。请检查本机控制接口、密钥、节点、出口和原始脚本；已有配置未自动接入客户端。' }))
    process.exitCode = 1
  })
}
