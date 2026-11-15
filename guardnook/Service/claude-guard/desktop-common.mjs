import { mkdir, lstat, chmod, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateConfig } from './config.mjs'
import { createController } from './controller.mjs'
import { verifyPolicy } from './guard.mjs'

const execute = promisify(execFile)
export async function run(file, args = [], options = {}) {
  try {
    const result = await execute(file, args, { timeout: 15000, maxBuffer: 1024 * 1024, ...options })
    return { ok: true, text: result.stdout.trim() }
  } catch { return { ok: false, text: '' } }
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('数据目录必须是普通目录，不能使用符号链接。')
  await chmod(path, 0o700)
}
export async function regularFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('数据文件不是普通文件，已停止操作。')
    return true
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export async function atomicJSON(path, value) {
  await regularFile(path)
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
export const desktopRoot = (home = homedir()) => join(home, 'Library/Application Support/GuardNook')
export async function readGuardConfig(home = homedir()) {
  const primary = join(desktopRoot(home), 'config.json')
  const fallback = join(home, 'Library/Application Support/ClaudeGuard/config.json')
  const hasPrimary = await regularFile(primary)
  if (!hasPrimary && await regularFile(join(desktopRoot(home), 'monitor.json'))) throw new Error('基础监测未接入固定出口保护。')
  if (!hasPrimary) throw new Error('请先在 GuardNook 中明确连接代理与守护。')
  const file = primary
  if (!await regularFile(file)) throw new Error('请先在 GuardNook 中配置并启用保护。')
  const input = JSON.parse(await readFile(file, 'utf8'))
  if (input.serviceMode === 'existing') {
    // The portable profile intentionally omits the legacy gateway password.
    // Use its private source only after verifying this is the same installation.
    if (!await regularFile(fallback)) throw new Error('原守护配置不可读，请重新连接现有守护。')
    const existing = JSON.parse(await readFile(fallback, 'utf8'))
    for (const key of ['expectedIP', 'selectedProxy', 'policyGroup', 'gatewayProxy', 'pinnedProxy',
      'controllerSocket', 'controllerURL', 'controllerSecret', 'serverPort', 'clientPort', 'probePort',
      'gatewayPort', 'requireTun', 'guardGoogleAuth', 'coverageVersion', 'ownedProtection', 'upstreamChain', 'frozenExitProxy', 'gatewayAllowlist', 'kernelProcessPath']) {
      if (JSON.stringify(input[key]) !== JSON.stringify(existing[key]))
        throw new Error('现有守护配置身份不一致，请重新连接；未修改保护规则。')
    }
    return validateConfig({ ...existing, clientID: input.clientID || existing.clientID || 'verge' })
  }
  return validateConfig(input)
}
export function protectedStatus(status, config, now = Date.now()) {
  return status?.state === 'protected' && status.enabled === true && status.manual !== true
    && status.prepared === true && status.gateway?.open === true
    && status.gateway.expiresAt > now && status.expectedIP === config.expectedIP
    && status.last?.ip === config.expectedIP
    && (!config.requireTun || status.tunEnabled === true)
}
export async function guardEvidence(home = homedir()) {
  const config = await readGuardConfig(home)
  const controller = createController(config)
  const response = await fetch(`http://127.0.0.1:${config.serverPort}/api/claude-guard/status`, {
    signal: AbortSignal.timeout(4000), redirect: 'error',
  })
  if (!response.ok) throw new Error('无法确认守护服务状态。')
  const status = await response.json()
  const [configs, proxies, rules] = await Promise.all(['/configs', '/proxies', '/rules']
    .map(path => controller.request(path, 'GET', undefined, { timeoutMs: 3000 })))
  let policyValid = false
  try { policyValid = verifyPolicy({ configs, proxies, rules }, config) === true } catch { /* Report, never repair routing here. */ }
  return { config, status, configs, policyValid }
}
export async function readInput() {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > 32768) throw new Error('请求过大。')
  }
  return JSON.parse(text || '{}')
}
export function reply(value) { process.stdout.write(JSON.stringify(value) + '\n') }
