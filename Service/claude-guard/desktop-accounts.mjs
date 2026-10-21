import { readFile, readdir, lstat, mkdir, rename, rm, open, access, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isMainModule } from './entry.mjs'
import { run, desktopRoot, privateDirectory, regularFile, atomicJSON, requireProtected,
  readInput, reply } from './desktop-common.mjs'
import { inspectEnvironment } from './desktop-environment.mjs'

const validID = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const exists = async path => { try { await access(path); return true } catch { return false } }
async function directory(path, optional = false) {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('账号数据目录不能使用符号链接或普通文件。')
    return true
  } catch (error) { if (optional && error.code === 'ENOENT') return false; throw error }
}
export function accountName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('账号名称需为 1–40 个可显示字符。')
  return value.trim()
}
export function nextAccountName(accounts) {
  for (let number = 1; number < 10000; number++) {
    let value = number, name = ''
    while (value) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26) }
    if (!accounts.some(item => item.name === name)) return name
  }
  throw new Error('账号数量超出支持范围。')
}
async function copyDirectory(source, target) {
  const result = await run('/usr/bin/ditto', [source, target], { timeout: 180000 })
  if (!result.ok) throw new Error('快照复制未完成，可能是磁盘空间或文件权限问题；原数据仍保留。')
  await chmod(target, 0o700)
}
async function quitClaude() {
  const running = () => run('/usr/bin/pgrep', ['-f', '^/Applications/Claude\\.app/Contents/'])
  if (!(await running()).ok) return
  await run('/usr/bin/osascript', ['-e', 'tell application "Claude" to quit'])
  for (let i = 0; i < 60; i++) {
    if (!(await running()).ok) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Claude 尚未完全退出；请手动退出后重试。')
}
async function launchClaude() {
  if (!(await run('/usr/bin/open', ['-a', '/Applications/Claude.app'])).ok)
    throw new Error('Claude 未能启动，正在恢复切换前的数据。')
}
async function ensureStopped() {
  if ((await run('/usr/bin/pgrep', ['-f', '^/Applications/Claude\\.app/Contents/'])).ok)
    throw new Error('快照准备期间 Claude 被重新打开，已停止切换以保留新数据。')
}

// Only this helper owns GuardNook's snapshot store. Claude Switcher's store is
// read-only and imported only after an explicit user action.
export function createAccountManager({ home = homedir(), authorize = () => requireProtected(home),
  quit = quitClaude, launch = launchClaude, copy = copyDirectory, writeJSON = atomicJSON,
  checkStopped = ensureStopped } = {}) {
  const root = join(desktopRoot(home), 'accounts'), snapshots = join(root, 'snapshots')
  const live = join(home, 'Library/Application Support/Claude')
  const indexFile = join(root, 'index.json'), journalFile = join(root, 'transaction.json')
  const lockFile = join(root, 'operation.lock')
  const legacyRoot = join(home, '.claude-switcher/accounts')
  async function prepare() { await privateDirectory(desktopRoot(home)); await privateDirectory(root); await privateDirectory(snapshots) }
  async function index() {
    if (!await regularFile(indexFile)) return { version: 1, currentID: null, accounts: [] }
    const value = JSON.parse(await readFile(indexFile, 'utf8'))
    if (value.version !== 1 || !Array.isArray(value.accounts)
      || value.accounts.some(item => !validID(item.id) || accountName(item.name) !== item.name)
      || new Set(value.accounts.map(item => item.id)).size !== value.accounts.length
      || value.currentID !== null && !value.accounts.some(item => item.id === value.currentID))
      throw new Error('账号目录索引异常，未修改任何快照。')
    return value
  }
  async function journal() {
    if (!await regularFile(journalFile)) return null
    const value = JSON.parse(await readFile(journalFile, 'utf8'))
    if (!validID(value.transaction) || !['pending', 'committed'].includes(value.phase)
      || typeof value.hadLive !== 'boolean' || !value.previousIndex)
      throw new Error('恢复记录异常，请保留账号目录并手动检查。')
    // All filesystem paths are derived locally, never taken from journal strings.
    return value
  }
  const transactionPaths = id => ({
    prepared: live + '.guardnook-prepared-' + id, previous: live + '.guardnook-previous-' + id,
  })
  async function locked(operation, allowRecovery = false) {
    await prepare()
    let handle
    try { handle = await open(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!await regularFile(lockFile)) throw new Error('账号操作锁异常。')
      let owner
      try { owner = JSON.parse(await readFile(lockFile, 'utf8')) } catch { throw new Error('账号操作锁异常，请保留数据并重启应用。') }
      if (!Number.isInteger(owner.pid) || owner.pid < 2) throw new Error('账号操作锁异常。')
      try { process.kill(owner.pid, 0); throw new Error('另一个账号操作仍在执行，请稍候。') }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe }
      await rm(lockFile)
      handle = await open(lockFile, 'wx', 0o600)
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }))
      if (!allowRecovery && await journal()) throw new Error('上一次切换未完成，请先使用“恢复未完成切换”。')
      return await operation()
    } finally { await handle.close(); await rm(lockFile, { force: true }) }
  }
  async function saveSnapshot(id, source) {
    await directory(source)
    const temporary = join(snapshots, id + '.tmp-' + randomUUID()), target = join(snapshots, id)
    const previous = join(snapshots, id + '.previous-' + randomUUID())
    let moved = false
    try {
      await copy(source, temporary)
      if (await directory(target, true)) { await rename(target, previous); moved = true }
      try { await rename(temporary, target) }
      catch (error) { if (moved) await rename(previous, target); throw error }
      // Keeping an old snapshot on cleanup failure is safer than rolling back a completed save.
      if (moved) await rm(previous, { recursive: true, force: true }).catch(() => {})
    } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }
  async function recoverInternal() {
    const transaction = await journal()
    if (!transaction) return
    const paths = transactionPaths(transaction.transaction)
    if (transaction.phase === 'pending') {
      await quit()
      const previousExists = await directory(paths.previous, true)
      const preparedExists = await directory(paths.prepared, true)
      if (transaction.hadLive && !previousExists && !preparedExists)
        throw new Error('恢复备份不完整，请保留当前数据和恢复记录后手动检查。')
      if (previousExists || !transaction.hadLive && !preparedExists) {
        if (await directory(live, true)) {
          const recovered = join(root, 'recovered'); await privateDirectory(recovered)
          await rename(live, join(recovered, transaction.transaction))
        }
        if (previousExists) await rename(paths.previous, live)
      }
      await writeJSON(indexFile, transaction.previousIndex)
    }
    await rm(paths.prepared, { recursive: true, force: true })
    await rm(paths.previous, { recursive: true, force: true })
    await rm(journalFile)
  }
  async function list() {
    await prepare()
    const value = await index(), legacy = []
    if (await directory(legacyRoot, true)) {
      for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[A-Z][A-Z0-9_-]{0,20}$/.test(entry.name)
          && !value.accounts.some(item => item.legacySource === entry.name)) legacy.push(entry.name)
      }
    }
    let needsRecovery = false
    try { needsRecovery = !!await journal() } catch { needsRecovery = true }
    return { ...value, legacyAvailable: legacy.sort(), recoveryRequired: needsRecovery }
  }
  const createEntry = (value, name) => ({ id: randomUUID(), name: accountName(name || nextAccountName(value.accounts)),
    createdAt: Date.now(), initialized: false, snapshotAt: null })
  async function create(name) {
    return locked(async () => { const value = await index(); value.accounts.push(createEntry(value, name)); await writeJSON(indexFile, value) })
  }
  async function renameAccount(id, name) {
    return locked(async () => {
      const value = await index(), item = value.accounts.find(item => item.id === id)
      if (!item) throw new Error('未找到账号。')
      item.name = accountName(name); await writeJSON(indexFile, value)
    })
  }
  async function adopt(name) {
    return locked(async () => {
      if (!await directory(live, true) || !(await readdir(live)).length) throw new Error('尚未发现 Claude 本地数据，请先登录。')
      const value = await index()
      if (value.currentID) throw new Error('当前登录已由账号列表管理，请使用切换或重命名。')
      await quit()
      const item = createEntry(value, name)
      await saveSnapshot(item.id, live)
      item.initialized = true; item.snapshotAt = Date.now(); value.accounts.push(item); value.currentID = item.id
      await writeJSON(indexFile, value)
      // Saving a snapshot never bypasses a blocked guard just to reopen the app.
      try { await authorize(); await launch() } catch { /* Data saved; remain closed when not verified. */ }
    })
  }
  async function switchTo(id) {
    return locked(async () => {
      const value = await index(), target = value.accounts.find(item => item.id === id)
      if (!validID(id) || !target) throw new Error('未找到目标账号。')
      await authorize()
      if (value.currentID === id) { await authorize(); await launch(); return }
      await quit()
      const hadLive = await directory(live, true)
      if (hadLive && (await readdir(live)).length) {
        let current = value.accounts.find(item => item.id === value.currentID)
        if (!current) { current = createEntry(value); value.accounts.push(current); value.currentID = current.id }
        await saveSnapshot(current.id, live)
        current.initialized = true; current.snapshotAt = Date.now()
        await writeJSON(indexFile, value)
      }
      const previousIndex = JSON.parse(JSON.stringify(value)), transaction = randomUUID()
      const paths = transactionPaths(transaction)
      let journalWritten = false
      try {
        if (target.initialized) {
          await directory(join(snapshots, target.id))
          await copy(join(snapshots, target.id), paths.prepared)
        } else await mkdir(paths.prepared, { mode: 0o700 })
        await authorize(); await checkStopped()
        await writeJSON(journalFile, { transaction, phase: 'pending', hadLive, previousIndex })
        journalWritten = true
        if (hadLive) await rename(live, paths.previous)
        await rename(paths.prepared, live)
        value.currentID = id
        await writeJSON(indexFile, value)
        await authorize(); await launch()
        await writeJSON(journalFile, { transaction, phase: 'committed', hadLive, previousIndex })
        await recoverInternal()
      } catch (error) {
        if (journalWritten) {
          try { await recoverInternal() }
          catch { throw new Error('切换未完成，旧数据仍保留。请使用“恢复未完成切换”，不要手动删除目录。') }
        } else await rm(paths.prepared, { recursive: true, force: true })
        throw error
      }
    })
  }
  async function importLegacy() {
    return locked(async () => {
      const available = (await list()).legacyAvailable
      if (!available.length) throw new Error('没有可导入的切换器快照。')
      const value = await index()
      for (const name of available) {
        const source = join(legacyRoot, name); await directory(source)
        const item = createEntry(value, name); item.legacySource = name
        await saveSnapshot(item.id, source)
        item.initialized = true; item.snapshotAt = Date.now(); value.accounts.push(item)
        await writeJSON(indexFile, value)
      }
    })
  }
  return { list, create, rename: renameAccount, adopt, switchTo, importLegacy,
    recover: () => locked(recoverInternal, true) }
}
export async function accountRequest(input) {
  if (process.platform !== 'darwin') throw new Error('此功能目前支持 macOS。')
  const manager = createAccountManager()
  switch (input.action) {
    case 'list': break
    case 'create': await manager.create(input.name); break
    case 'rename': await manager.rename(input.id, input.name); break
    case 'adopt': await manager.adopt(input.name); break
    case 'import': await manager.importLegacy(); break
    case 'recover': await manager.recover(); break
    case 'switch': {
      const audit = await inspectEnvironment()
      const failed = audit.rows.filter(row => row.blocking && row.state !== 'ok')
      if (failed.length) throw new Error('请先处理环境检查：' + failed.map(row => row.title).join('、'))
      await manager.switchTo(input.id); break
    }
    default: throw new Error('未知账号操作。')
  }
  return { accounts: await manager.list() }
}
if (isMainModule(import.meta.url)) {
  try { reply(await accountRequest(await readInput())) }
  catch (error) {
    reply({ error: error.code ? `账号操作未完成（${error.code}），请保留原数据后重试。` : error.message || '账号操作未完成。' })
    process.exitCode = 1
  }
}
