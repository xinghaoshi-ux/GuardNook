// Account secrets stay in the owning client's credential store. Only normalized
// quota snapshots leave this short-lived helper; never print provider errors.
import { spawn, execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import { createHash } from 'node:crypto'
import { readGuardConfig, protectedStatus, readInput, reply } from './desktop-common.mjs'
import { connectTunnel } from './tunnel.mjs'
import { isMainModule } from './entry.mjs'

const execute = promisify(execFile)
const stamp = () => Date.now()
const validPercent = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100
const validEpoch = x => typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 4102444800
export const failed = (provider, state, note, retryAt) => ({ provider, state, note, checkedAt: stamp(), windows: [], ...(retryAt ? { retryAt } : {}) })

export function quotaWindow(id, title, used, resetsAt) {
  if (!validPercent(used)) return null
  return { id, title, remainingPercent: Math.round((100 - used) * 10) / 10,
    resetAt: validEpoch(resetsAt) ? resetsAt * 1000 : null }
}
export function normalizeCodex(result) {
  const snapshot = result?.rateLimitsByLimitId?.codex || result?.rateLimits
  if (!snapshot || snapshot.limitId && snapshot.limitId !== 'codex') return []
  return [['primary', snapshot.primary], ['secondary', snapshot.secondary]].flatMap(([id, w]) => {
    if (!w) return []
    const duration = w.windowDurationMins
    const title = duration === 300 ? '五小时' : duration === 10080 ? '每周'
      : Number.isFinite(duration) && duration > 0 ? `${duration} 分钟` : id === 'primary' ? '当前窗口' : '长期窗口'
    const window = quotaWindow(id, title, w.usedPercent, w.resetsAt)
    return window ? [window] : []
  })
}
export function normalizeClaude(result) {
  return [['five_hour', '五小时'], ['seven_day', '每周']].flatMap(([id, title]) => {
    const row = result?.[id]
    if (!row) return []
    const reset = typeof row.resets_at === 'string' ? Date.parse(row.resets_at) / 1000 : row.resets_at
    const window = quotaWindow(id, title, row.utilization, reset)
    return window ? [window] : []
  })
}

export async function findCodex(home = homedir()) {
  const paths = [join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Applications/Codex.app/Contents/Resources/codex']
  for (const path of paths) { try { await access(path, 1); return path } catch {} }
  return null
}

export async function fetchCodex({ executable, timeoutMs = 35000, retryDelayMs = 350, spawnProcess = spawn } = {}) {
  executable ||= await findCodex()
  if (!executable) return failed('codex', 'unavailable', '未找到 Codex CLI；安装并登录后可监测。')
  return new Promise(resolve => {
    const child = spawnProcess(executable, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], cwd: homedir() })
    let done = false, account, total = 0, phase = 'initialize', accountAttempts = 0, accountRequestID = 1, retry
    const finish = value => { if (done) return; done = true; clearTimeout(timer); clearTimeout(retry); lines.close(); child.stdin.destroy(); child.kill(); resolve(value) }
    const timer = setTimeout(() => finish(failed('codex', 'unavailable', 'Codex 用量请求超时，稍后重试。')), timeoutMs)
    const lines = createInterface({ input: child.stdout })
    const send = msg => { if (!done && !child.stdin.destroyed) child.stdin.write(JSON.stringify(msg) + '\n') }
    const readAccount = () => {
      phase = 'account'; accountAttempts++; accountRequestID = accountAttempts === 1 ? 1 : 3
      send({ id: accountRequestID, method: 'account/read', params: { refreshToken: false } })
    }
    const retryAccount = result => {
      if (accountAttempts >= 2) { finish(result); return }
      phase = 'retry'; retry = setTimeout(readAccount, retryDelayMs)
    }
    child.stdin.on('error', () => finish(failed('codex', 'unavailable', 'Codex 本机服务连接中断。')))
    child.on('error', () => finish(failed('codex', 'unavailable', 'Codex 本机服务无法启动。')))
    child.on('exit', () => finish(failed('codex', 'unavailable', 'Codex 本机服务已退出。')))
    lines.on('line', line => {
      total += Buffer.byteLength(line)
      if (total > 1024 * 1024) { finish(failed('codex', 'unavailable', 'Codex 返回数据超出限制。')); return }
      let msg; try { msg = JSON.parse(line) } catch { return }
      // Requests/notifications can reuse numeric IDs in the opposite direction.
      // Only RPC responses can establish whether this account is logged in.
      if (!msg || typeof msg !== 'object' || typeof msg.method === 'string'
        || !Object.hasOwn(msg, 'result') && !Object.hasOwn(msg, 'error')) return
      // No thread/start or turn/start: this client only reads account limits.
      if (phase === 'initialize' && msg.id === 0) {
        if (msg.error) { finish(failed('codex', 'unavailable', 'Codex 本机协议初始化失败。')); return }
        send({ method: 'initialized' }); readAccount()
      } else if (phase === 'account' && msg.id === accountRequestID) {
        if (msg.error || !msg.result || !Object.hasOwn(msg.result, 'account')) {
          retryAccount(failed('codex', 'unavailable', 'Codex 账号状态暂时无法读取，稍后自动重试。')); return
        }
        account = msg.result?.account
        if (!account) {
          if (msg.result.account === null && msg.result.requiresOpenaiAuth === true) {
            retryAccount(failed('codex', 'auth-required', 'Codex CLI 当前未登录，请在官方客户端登录后刷新。'))
          } else if (msg.result.account === null && msg.result.requiresOpenaiAuth === false) {
            finish(failed('codex', 'unsupported', '当前服务未使用 ChatGPT 订阅登录，没有可显示的订阅额度。'))
          } else { retryAccount(failed('codex', 'unavailable', 'Codex 账号返回格式无法确认，稍后自动重试。')) }
          return
        }
        if (account.type !== 'chatgpt') { finish(failed('codex', 'unsupported', '当前为 API / 第三方模式，没有 ChatGPT 订阅额度。')); return }
        phase = 'limits'
        send({ id: 2, method: 'account/rateLimits/read' })
      } else if (phase === 'limits' && msg.id === 2) {
        if (msg.error) { finish(failed('codex', 'unavailable', 'Codex 暂未返回订阅额度，请检查本机登录。')); return }
        const windows = normalizeCodex(msg.result)
        if (!windows.length) { finish(failed('codex', 'unavailable', '当前账号没有可显示的额度窗口。')); return }
        const plan = ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu'].includes(account.planType) ? account.planType : null
        const accountRef = createHash('sha256').update(String(msg.result.accountId || account.email || 'local')).digest('hex')
        finish({ provider: 'codex', state: 'ready', checkedAt: stamp(), fetchedAt: stamp(), plan, accountRef, windows,
          note: 'Codex 官方本机服务 · 普通网络', route: 'system' })
      }
    })
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'guardnook_usage', title: 'GuardNook Usage', version: '0.4.1' } } })
  })
}

export async function localGuardStatus(config) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: config.serverPort, path: '/api/claude-guard/status', timeout: 1500 }, res => {
      let raw = ''; res.setEncoding('utf8')
      res.on('data', c => { raw += c; if (raw.length > 128 * 1024) req.destroy() })
      res.on('end', () => { try { if (res.statusCode !== 200) throw Error(); resolve(JSON.parse(raw)) } catch { reject(Error('guard-unavailable')) } })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(Error('guard-timeout'))); req.on('error', reject)
  })
}
export function usageGuardReady(status, config) {
  return protectedStatus(status, config) && status.policyGroup === config.policyGroup
    && status.pinnedProxy === config.pinnedProxy && config.requireTun === true && status.tunEnabled === true
    && status.gateway?.clientGatewayPort === config.clientPort && status.gateway?.destinationRestricted === true
}

export async function claudeAccessToken() {
  try {
    const { stdout } = await execute('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 12000, maxBuffer: 32768 })
    const oauth = JSON.parse(stdout)?.claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken.length || oauth.accessToken.length > 8192) return null
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= stamp()) return { reason: 'expired' }
    // Only use accessToken; never implement refresh-token exchange here.
    return oauth.accessToken
  } catch { return null }
}

export async function refreshClaudeAccess(config, { check = () => localGuardStatus(config), tokenProvider = claudeAccessToken,
  spawnProcess = spawn, executable, timeoutMs = 20000, pollMs = 1000 } = {}) {
  const ports = [config.serverPort, config.clientPort]
  if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || ports[0] === ports[1]) return null
  try { if (!usageGuardReady(await check(), config)) return null } catch { return null }
  if (!executable) {
    for (const path of [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
      try { await access(path, 1); executable = path; break } catch {}
    }
  }
  if (!executable || !executable.startsWith('/')) return null
  const profile = '(version 1) (allow default) (deny network*) (allow network-outbound '
    + ports.map(p => `(remote ip "localhost:${p}")`).join(' ') + ')'
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().endsWith('_PROXY') || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].includes(name)) delete env[name]
  }
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) env[name] = `http://127.0.0.1:${config.clientPort}`
  Object.assign(env, { NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', TERM: 'xterm-256color',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    GUARDNOOK_USAGE_CLAUDE_EXECUTABLE: executable })
  return new Promise(resolve => {
    let child, done = false, checking = false, reading = false, deadline, monitor, poll
    const finish = token => {
      if (done) return; done = true
      clearTimeout(deadline); clearInterval(monitor); clearInterval(poll)
      child?.stdin?.destroy()
      let stopped = false
      if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); stopped = true } catch {} }
      if (!stopped) child?.kill()
      resolve(token)
    }
    try {
      // A PTY lets the official client initialize normally. No prompt, slash
      // command, consent response or model request is ever written to stdin.
      const terminal = `set timeout 22
log_user 0
spawn -noecho $env(GUARDNOOK_USAGE_CLAUDE_EXECUTABLE) --safe-mode --setting-sources "" --tools "" --strict-mcp-config --mcp-config {{"mcpServers":{}}}
trap {catch {exec /bin/kill -TERM [exp_pid]}; catch {close}; exit 0} {SIGTERM SIGINT SIGHUP}
expect {eof {exit 0} timeout {catch {exec /bin/kill -TERM [exp_pid]}; catch {close}; exit 1}}`
      child = spawnProcess('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/expect', '-c', terminal],
      { stdio: ['pipe', 'ignore', 'ignore'], detached: true, cwd: '/private/tmp', env })
      child.on('error', () => finish(null)); child.on('exit', () => finish(null))
      child.stdin?.on('error', () => finish(null))
      deadline = setTimeout(() => finish(null), timeoutMs)
      monitor = setInterval(async () => {
        if (done || checking) return; checking = true
        try { if (!usageGuardReady(await check(), config)) finish(null) } catch { finish(null) } finally { checking = false }
      }, 500)
      poll = setInterval(async () => {
        if (done || reading) return; reading = true
        try {
          if (!usageGuardReady(await check(), config)) { finish(null); return }
          const token = await tokenProvider()
          if (typeof token === 'string' && token.length) finish(token)
          else if (!token) finish(null)
        } catch { finish(null) } finally { reading = false }
      }, pollMs)
    } catch { finish(null) }
  })
}

export async function requestClaudeUsage(config, token, { check = () => localGuardStatus(config), timeoutMs = 12000, connect = connectTunnel } = {}) {
  let raw, secure, request, monitor, deadline, agent
  try {
    if (!usageGuardReady(await check(), config)) throw Error('guard-closed')
    raw = await connect(config, 'api.anthropic.com:443', config.clientPort)
    secure = tls.connect({ socket: raw, servername: 'api.anthropic.com', rejectUnauthorized: true })
    agent = new https.Agent({ keepAlive: false }); agent.createConnection = () => secure
    const response = await new Promise((resolve, reject) => {
      let checking = false
      const abort = () => { request?.destroy(Error('guard-closed')); secure?.destroy(); raw?.destroy(); reject(Error('guard-closed')) }
      monitor = setInterval(async () => {
        if (checking) return; checking = true
        try { if (!usageGuardReady(await check(), config)) abort() } catch { abort() } finally { checking = false }
      }, 500)
      deadline = setTimeout(() => { request?.destroy(Error('timeout')); reject(Error('timeout')) }, timeoutMs)
      request = https.request({ hostname: 'api.anthropic.com', port: 443, path: '/api/oauth/usage', method: 'GET', agent,
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json', 'accept-encoding': 'identity' } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('error', reject)
        res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 65536) request.destroy(Error('response-limit')) })
        res.on('end', () => resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'], text }))
      })
      request.on('error', reject); secure.on('error', reject); request.end()
    })
    if (!usageGuardReady(await check(), config)) throw Error('guard-closed')
    if (response.status === 401) return failed('claude', 'auth-required', 'Claude 登录已过期，请在 Claude Code 中重新登录；不会复制或刷新其令牌。')
    if (response.status === 429) {
      const seconds = Number(response.retryAfter), date = Date.parse(response.retryAfter)
      const retryAt = Number.isFinite(seconds) ? stamp() + Math.max(60, seconds) * 1000 : Number.isFinite(date) ? Math.max(stamp() + 60000, date) : stamp() + 300000
      return failed('claude', 'limited', 'Claude 用量接口限流，等待后再更新。', retryAt)
    }
    if (response.status === 403) return failed('claude', 'unavailable', 'Claude 拒绝了用量查询；不会更换出口或绕过限制。')
    if (response.status !== 200) return failed('claude', 'unavailable', 'Claude 用量请求未完成；不会跟随重定向或改走直连。')
    let body; try { body = JSON.parse(response.text) } catch { return failed('claude', 'unavailable', 'Claude 返回格式无法识别。') }
    const windows = normalizeClaude(body)
    if (!windows.length) return failed('claude', 'unavailable', 'Claude 没有返回有效的额度窗口。')
    return { provider: 'claude', state: 'ready', checkedAt: stamp(), fetchedAt: stamp(), windows,
      note: '指定守护通道 · 异常停止查询', route: 'guard', exitIP: config.expectedIP }
  } finally { clearInterval(monitor); clearTimeout(deadline); request?.destroy(); agent?.destroy(); secure?.destroy(); raw?.destroy() }
}

export async function fetchClaude({ home = homedir(), tokenProvider = claudeAccessToken, configProvider = readGuardConfig, checkProvider = localGuardStatus,
  requester = requestClaudeUsage, refreshProvider = refreshClaudeAccess } = {}) {
  let config
  try {
    config = await configProvider(home)
    if (!usageGuardReady(await checkProvider(config), config)) return failed('claude', 'blocked', '等待 TUN 与 Guard 指定通道验证通过。')
  } catch { return failed('claude', 'blocked', '无法确认 Guard 指定通道，已暂停查询。') }
  let token = await tokenProvider()
  if (token?.reason === 'expired') {
    try { token = await refreshProvider(config, { check: () => checkProvider(config), tokenProvider }) } catch { token = null }
    try { if (!usageGuardReady(await checkProvider(config), config)) return failed('claude', 'blocked', 'Guard 指定通道未通过，已停止登录状态更新。') }
    catch { return failed('claude', 'blocked', '无法确认 Guard 指定通道，已停止登录状态更新。') }
    if (typeof token !== 'string' || !token.length) return failed('claude', 'refresh-required', 'Claude Code 登录待同步；请在官方 CLI 更新登录后刷新。桌面端登录与此状态分别维护。')
  }
  if (!token) return failed('claude', 'auth-required', '请先登录 Claude Code，并允许本机钥匙串访问；不需要粘贴 Cookie。')
  try { return await requester(config, token, { check: () => checkProvider(config) }) }
  catch { return failed('claude', 'unavailable', '守护通道中断或请求失败；没有回退直连。') }
}

if (isMainModule(import.meta.url)) {
  try {
    const input = await readInput()
    if (input.provider === 'codex') reply(await fetchCodex())
    else if (input.provider === 'claude') reply(await fetchClaude())
    else reply(failed('unknown', 'unsupported', '不支持的监测服务。'))
  } catch { reply(failed('unknown', 'unavailable', '用量监测未完成。')); process.exitCode = 1 }
}
