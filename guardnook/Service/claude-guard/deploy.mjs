// Deliberate local deployment: offline validation and exact backups precede writes.
import { readFile, writeFile, cp, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { applyClaudeGuard } from './profile.mjs'
import { validateConfig } from './config.mjs'
import { createController } from './controller.mjs'
import { verifyPolicy } from './guard.mjs'
import { launchAgent, LABEL } from './install.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bootstrap(plist) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { stdio: 'pipe' }); return }
    catch { await delay(750) }
  }
  throw new Error('launchd-bootstrap-failed')
}
export async function deploy() {
  const home = homedir(), root = join(home, 'Library/Application Support/ClaudeGuard')
  const base = join(home, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev')
  const install = JSON.parse(await readFile(join(root, 'INSTALL.json'), 'utf8'))
  if (install.activated) throw new Error('Already deployed')
  const config = validateConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')))
  const runtimePath = join(base, 'clash-verge.yaml')
  const oldRuntime = await readFile(runtimePath), oldScript = await readFile(install.profileScript)
  const backupScript = await readFile(join(install.backup, 'original-Script.js'))
  if (digest(oldScript) !== digest(backupScript)) throw new Error('Script changed since installation')
  const original = JSON.parse(execFileSync('/usr/bin/ruby', ['-ryaml', '-rjson', '-e',
    'print JSON.generate(YAML.load_file(ARGV[0]))', runtimePath], { encoding: 'utf8' }))
  const prepared = applyClaudeGuard(original, config)
  const changed = Object.keys(prepared).filter(k => JSON.stringify(prepared[k]) !== JSON.stringify(original[k]))
  if (changed.some(k => !['proxies', 'proxy-groups', 'listeners', 'rules'].includes(k))) throw new Error('Unexpected config changes')
  const candidate = join(root, 'prepared-runtime.yaml')
  const yaml = execFileSync('/usr/bin/ruby', ['-ryaml', '-rjson', '-e', 'print YAML.dump(JSON.parse(STDIN.read))'],
    { input: JSON.stringify(prepared), encoding: 'utf8' })
  await writeFile(candidate, yaml, { mode: 0o600 })
  try {
    execFileSync('/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo', ['-t', '-f', candidate, '-d', base], { stdio: 'pipe', timeout: 15000 })
  } catch { throw new Error('Prepared Mihomo configuration failed validation') }
  for (const name of ['clash-verge.yaml', 'profiles.yaml', 'verge.yaml', 'config.yaml', 'dns_config.yaml'])
    await cp(join(base, name), join(install.backup, name))
  const before = { script: digest(oldScript), runtime: digest(oldRuntime) }
  const controller = createController(config)
  const writeAtomic = async (path, bytes) => { await writeFile(`${path}.claude-guard-tmp`, bytes, { mode: 0o600 }); await rename(`${path}.claude-guard-tmp`, path) }
  const service = `gui/${process.getuid()}/${LABEL}`
  const plist = join(home, `Library/LaunchAgents/${LABEL}.plist`)
  let stage = 'select-reject'
  try {
    // Close the old protected selector before replacing it; never choose DIRECT.
    await controller.select('REJECT')
    stage = 'write-profiles'
    await writeAtomic(install.profileScript, await readFile(join(root, 'prepared-Script.js')))
    await writeAtomic(runtimePath, yaml)
    stage = 'reload-controller'
    await controller.request('/configs?force=true', 'PUT', { path: runtimePath })
    stage = 'verify-policy'
    const [configs, proxies, rules] = await Promise.all([controller.request('/configs'), controller.request('/proxies'), controller.request('/rules')])
    verifyPolicy({ configs, proxies, rules }, config)
    stage = 'restart-service'
    try { execFileSync('/bin/launchctl', ['bootout', service], { stdio: 'pipe' }) } catch {}
    await writeAtomic(plist, launchAgent(root, '/opt/homebrew/bin/node', true))
    await bootstrap(plist)
    install.activated = true
    await writeAtomic(join(root, 'INSTALL.json'), JSON.stringify(install, null, 2))
    await writeFile(join(install.backup, 'deployment-result.json'), JSON.stringify({ activatedAt: new Date().toISOString(),
      changed, before, after: { script: digest(await readFile(install.profileScript)), runtime: digest(await readFile(runtimePath)) },
      unrelatedSettingsPreserved: true, expectedIP: config.expectedIP }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ deployed: true, changed, backup: install.backup, dashboard: `http://127.0.0.1:${config.serverPort}/#/claude-guard` }))
  } catch (error) {
    // Restore exact files but leave the Claude selector blocked until a verified recovery.
    await writeAtomic(install.profileScript, oldScript)
    await writeAtomic(runtimePath, oldRuntime)
    try { await controller.request('/configs?force=true', 'PUT', { path: runtimePath }); await controller.select('REJECT') } catch {}
    try { execFileSync('/bin/launchctl', ['print', service], { stdio: 'pipe' }) } catch { try { await bootstrap(plist) } catch {} }
    throw new Error(`Deployment failed at ${stage} (${['rule-mode-required', 'guard-route-not-installed', 'protected-rules-changed'].includes(error.message) ? error.message : error.code || 'local-operation-error'}); original files restored, Claude remains blocked where controller is available`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  deploy().catch(error => { console.error(error.message); process.exitCode = 1 })
