import { cp, mkdir, readFile, writeFile, readdir, access, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { validateConfig } from './config.mjs'
import { composeProfileScript } from './profile.mjs'
import { Script } from 'node:vm'

export const LABEL = 'local.claude-egress-guard'
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export function launchAgent(root, nodePath, enforce = false) {
  const args = [nodePath, join(root, 'lib/main.mjs'), '--config', join(root, 'config.json'), '--static', join(root, 'public')]
  if (enforce) args.push('--enforce')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(x => `<string>${escape(x)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string><key>NODE_EXTRA_CA_CERTS</key><string></string></dict>
<key>StandardOutPath</key><string>${escape(join(root, 'logs/service.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(root, 'logs/error.log'))}</string>
<key>ProcessType</key><string>Background</string>
<key>ExitTimeOut</key><integer>15</integer>
</dict></plist>\n`
}

export async function install(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('macOS installer only')
  const source = fileURLToPath(new URL('.', import.meta.url))
  const repo = resolve(source, '../..')
  const home = homedir()
  const root = join(home, 'Library/Application Support/ClaudeGuard')
  const plist = join(home, `Library/LaunchAgents/${LABEL}.plist`)
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const backup = join(home, 'ClaudeBackups', `claude-guard-install-${stamp}`)
  const profileArg = args.indexOf('--profile-script')
  const scriptPath = profileArg >= 0 ? resolve(args[profileArg + 1]) : join(home, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/profiles/Script.js')
  const ui = join(repo, 'packages/ui/.output/public')
  await access(join(ui, 'index.html'))
  let oldConfig
  try { oldConfig = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) } catch {}
  const config = validateConfig({ ...oldConfig, proxyPassword: oldConfig?.proxyPassword || randomBytes(32).toString('hex') })
  const original = await readFile(scriptPath, 'utf8')
  if (original.includes('__previousClaudeMain')) throw new Error('Already activated: use the saved original script when updating')
  const composed = composeProfileScript(original, config)
  new Script(composed)
  await mkdir(backup, { recursive: true, mode: 0o700 })
  try { await access(root); await access(join(root, 'INSTALL.json')); await cp(root, join(backup, 'previous-install'), { recursive: true }) } catch (error) {
    try { await access(root); throw new Error('Installation directory is in use without our manifest') } catch (missing) { if (missing.code !== 'ENOENT') throw missing }
  }
  try { await cp(plist, join(backup, 'previous-launch-agent.plist')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await cp(scriptPath, join(backup, 'original-Script.js'))
  await writeFile(join(backup, 'README.txt'), 'Private local configuration backup. Contains existing proxy credentials; do not publish.\n', { mode: 0o600 })
  const staging = `${root}.install-${stamp}`
  await mkdir(join(staging, 'lib'), { recursive: true, mode: 0o700 })
  await mkdir(join(staging, 'logs'), { mode: 0o700 })
  for (const name of await readdir(source)) {
    if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) await cp(join(source, name), join(staging, 'lib', name))
  }
  await cp(ui, join(staging, 'public'), { recursive: true })
  await writeFile(join(staging, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
  await writeFile(join(staging, 'prepared-Script.js'), composed, { mode: 0o600 })
  await writeFile(join(staging, 'INSTALL.json'), JSON.stringify({ version: 1, installedAt: new Date().toISOString(),
    source: repo, backup, profileScript: scriptPath, activated: false }, null, 2), { mode: 0o600 })
  // Replacement happens only after an existing managed service is stopped.
  if (oldConfig) {
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'pipe' }) } catch {}
    await rename(root, join(backup, 'replaced-install'))
  }
  await rename(staging, root)
  await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true })
  const stableNode = '/opt/homebrew/bin/node'
  await access(stableNode)
  await writeFile(plist, launchAgent(root, stableNode, args.includes('--enforce')), { mode: 0o600 })
  const appRoot = join(home, 'Applications/Claude Guard.app/Contents')
  try { await access(appRoot); throw new Error('App launcher already exists') } catch (e) { if (e.code !== 'ENOENT') throw e }
  await mkdir(join(appRoot, 'MacOS'), { recursive: true })
  await writeFile(join(appRoot, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.claude-guard.panel</string><key>CFBundleName</key><string>Claude Guard</string><key>CFBundleExecutable</key><string>open-panel</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  await writeFile(join(appRoot, 'MacOS/open-panel'), `#!/bin/sh\nexec /usr/bin/open 'http://127.0.0.1:${config.serverPort}/#/claude-guard'\n`, { mode: 0o755 })
  execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'pipe' })
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { stdio: 'pipe' })
  console.log(JSON.stringify({ installed: root, backup, launchAgent: plist, app: join(home, 'Applications/Claude Guard.app'),
    dashboard: `http://127.0.0.1:${config.serverPort}/#/claude-guard`, enforcement: args.includes('--enforce') }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch(() => { console.error('Installation did not complete. Review port/path availability and the private backup before retrying.'); process.exitCode = 1 })
}
