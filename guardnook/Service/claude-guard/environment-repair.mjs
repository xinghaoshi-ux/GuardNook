import { readFile, writeFile, rename, readdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { run, desktopRoot, privateDirectory, regularFile, atomicJSON, readGuardConfig } from './desktop-common.mjs'
import { createController } from './controller.mjs'
import { clientAdapter, activeNetworkServices } from './clients.mjs'
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const titles = { tun: 'TUN 配置', timezone: '系统时区', locale: '系统地区', ipv6: '网络服务 IPv6', language: 'Claude 语言' }
const stateToken = state => createHash('sha256').update(JSON.stringify(Object.keys(state.before).sort().map(id => [id,state.before[id],state.after[id]]))).digest('hex')
const digest = c => createHash('sha256').update(JSON.stringify([c.controllerSocket,c.controllerURL,c.controllerSecret,c.policyGroup,c.expectedIP])).digest('hex')
export function ipv6State(text) {
  const mode = text.match(/^IPv6:\s*(.+)$/im)?.[1]?.trim()
  if (!['Off','Automatic','Link-local only','Manual'].includes(mode)) throw new Error('无法确认当前 IPv6 配置，未修改网络。')
  if (mode !== 'Manual') return { mode }
  const address = text.match(/^IPv6 IP address:\s*(\S+)/im)?.[1]
  const prefix = text.match(/^IPv6 Prefix Length:\s*(\d+)/im)?.[1]
  const router = text.match(/^IPv6 Router:\s*(\S+)/im)?.[1]
  if (!address || !prefix || !router) throw new Error('手动 IPv6 参数不完整，无法提供可靠恢复，未修改网络。')
  return { mode, address, prefix, router }
}
const defaultsArgs = (id, state) => state.exists ? ['write', id === 'locale' ? '-g' : 'com.anthropic.claudefordesktop',
  id === 'locale' ? 'AppleLocale' : 'AppleLanguages', ...(id === 'language' ? ['-array', ...state.value] : [state.value])]
  : ['delete', id === 'locale' ? '-g' : 'com.anthropic.claudefordesktop', id === 'locale' ? 'AppleLocale' : 'AppleLanguages']
export function createEnvironmentRepair({ home = homedir(), execute = run, getConfig = () => readGuardConfig(home), controllerFor = createController } = {}) {
  const root = join(desktopRoot(home), 'environment-backups-v2')
  async function locked(task) {
    await privateDirectory(desktopRoot(home)); await privateDirectory(root)
    const path = join(root, 'operation.lock'); let lock
    try { lock = await open(path, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !await regularFile(path)) throw error
      const owner = JSON.parse(await readFile(path, 'utf8'))
      if (!Number.isInteger(owner.pid) || owner.pid < 2) throw new Error('恢复锁异常，请保留备份。')
      try { process.kill(owner.pid, 0); throw new Error('另一项环境操作仍在执行。') } catch (e) { if (e.code !== 'ESRCH') throw e }
      await rm(path); lock = await open(path, 'wx', 0o600)
    }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await task() }
    finally { await lock.close(); await rm(path, { force: true }) }
  }
  async function capture(ids, policy) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !Object.hasOwn(titles, id)) || new Set(ids).size !== ids.length) throw new Error('请选择支持的修复项。')
    const before = {}, after = {}
    for (const id of ids) {
      if (id === 'timezone') {
        const value = await execute('/usr/bin/readlink', ['/etc/localtime'])
        const zone = value.text.split('/zoneinfo/')[1]
        if (!value.ok || !zone || !/^(?:UTC|[A-Za-z_+-]+\/[A-Za-z_+/-]+)$/.test(zone)) throw new Error('无法保存原时区，已停止修复。')
        before[id] = zone; after[id] = policy.timezone
      } else if (id === 'locale' || id === 'language') {
        const result = await execute('/usr/bin/defaults', ['read', id === 'locale' ? '-g' : 'com.anthropic.claudefordesktop', id === 'locale' ? 'AppleLocale' : 'AppleLanguages'])
        const value = id === 'locale' ? result.text : [...result.text.matchAll(/\b([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\b/g)].map(m => m[1])
        if (id === 'language' && result.ok && !value.length) throw new Error('无法识别原语言列表，已停止修复。')
        before[id] = { exists: result.ok, value }; after[id] = { exists: true, value: id === 'locale' ? policy.locale : [policy.language] }
      } else if (id === 'ipv6') {
        const services = await activeNetworkServices(execute)
        const service = services.find(value => value.name === policy.networkService) || (!policy.networkService ? services.find(value => value.active) : null)
        if (!service) throw new Error('请选择当前可用的网络服务，未修改网络。')
        before[id] = { service: service.name, ...ipv6State(service.info) }; after[id] = { service: service.name, mode: 'Off' }
      } else if (id === 'tun') {
        const c = await getConfig(), controller = controllerFor(c), configs = await controller.request('/configs')
        if (typeof configs.tun?.enable !== 'boolean') throw new Error('客户端没有提供可确认的 TUN 开关。')
        const adapter = clientAdapter(c.clientID || 'verge', home)
        let persisted = null
        if (adapter.tunFile) {
          if (!await regularFile(adapter.tunFile)) throw new Error('客户端偏好不可读，未修改 TUN。')
          const text = await readFile(adapter.tunFile, 'utf8'), match = text.match(/^enable_tun_mode:\s*(true|false)\s*$/m)
          if (!match) throw new Error('客户端持久化格式未知，请手动管理 TUN。')
          persisted = match[1] === 'true'
        }
        before[id] = { enable: configs.tun.enable, persisted, identity: digest(c), clientID: adapter.id }
        after[id] = { ...before[id], enable: true, persisted: persisted === null ? null : true }
      }
    }
    return { before, after }
  }
  const label = value => typeof value === 'string' ? value : value.mode ? `${value.service} · ${value.mode}` : Object.hasOwn(value, 'enable') ? (value.enable ? '开启' : '关闭') : value.exists ? [value.value].flat().join('、') : '未单独设置（沿用系统）'
  async function preview(ids, policy) {
    const state = await capture(ids, policy)
    return { planToken: stateToken(state), plan: ids.map(id => ({ id, title: titles[id], before: label(state.before[id]), after: label(state.after[id]) })) }
  }
  async function apply(id, value) {
    if (id === 'tun') {
      const c = await getConfig()
      if (digest(c) !== value.identity) throw new Error('守护身份已变化，已停止恢复 TUN。')
      const controller = controllerFor(c), adapter = clientAdapter(value.clientID, home)
      if (!value.enable && c.requireTun) await controller.select('REJECT')
      if (adapter.tunFile && value.persisted !== null) {
        const original = await readFile(adapter.tunFile, 'utf8')
        if (!/^enable_tun_mode:\s*(true|false)\s*$/m.test(original)) throw new Error('TUN 偏好格式已变化。')
        const temporary = adapter.tunFile + '.guardnook-' + randomUUID()
        try { await writeFile(temporary, original.replace(/^enable_tun_mode:\s*(true|false)\s*$/m, `enable_tun_mode: ${value.persisted}`), { mode: 0o600, flag: 'wx' }); await rename(temporary, adapter.tunFile) }
        finally { await rm(temporary, { force: true }) }
      }
      await controller.request('/configs', 'PATCH', { tun: { enable: value.enable } })
    } else if (id === 'locale' || id === 'language') {
      const args = defaultsArgs(id, value), result = await execute('/usr/bin/defaults', args)
      // Deleting an already absent preference is an idempotent restoration.
      if (!result.ok && value.exists) throw new Error('系统偏好写入未完成。')
    } else {
      let command
      if (id === 'timezone') command = '/usr/sbin/systemsetup -settimezone ' + quote(value)
      else {
        const mode = { Off: '-setv6off', Automatic: '-setv6automatic', 'Link-local only': '-setv6LinkLocal', Manual: '-setv6manual' }[value.mode]
        if (!mode) throw new Error('备份中的 IPv6 模式无效。')
        command = '/usr/sbin/networksetup ' + mode + ' ' + quote(value.service)
        if (value.mode === 'Manual') command += ' ' + [value.address, value.prefix, value.router].map(quote).join(' ')
      }
      const result = await execute('/usr/bin/osascript', ['-e', 'on run argv\nreturn do shell script (item 1 of argv) with prompt "GuardNook：应用已确认的环境更改" with administrator privileges\nend run', command], { timeout: 180000 })
      if (!result.ok) throw new Error('管理员验证取消或系统更改未完成，请查看操作结果并按需恢复。')
    }
  }
  async function history() {
    await privateDirectory(root)
    const records = []
    for (const name of (await readdir(root)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const file = join(root, name)
      if (!await regularFile(file)) continue
      try { const item = JSON.parse(await readFile(file, 'utf8')); if (item.version === 2) records.push({ id: item.id, at: item.at, status: item.status, detail: item.ids.map(id => titles[id]).join('、'), outcomes: item.outcomes }) } catch {}
    }
    return { history: records.sort((a, b) => b.at - a.at) }
  }
  async function repair(ids, policy, confirmedToken) {
    return locked(async () => {
      const state = await capture(ids, policy), id = randomUUID()
      if (confirmedToken !== undefined && confirmedToken !== stateToken(state)) throw new Error('系统值或环境基线已改变，请重新预览后确认。')
      const latest = (await history()).history[0]?.at || 0
      const record = { version: 2, id, at: Math.max(Date.now(), latest + 1), ids, ...state, status: 'applying', outcomes: [] }
      const file = join(root, id + '.json'); await atomicJSON(file, record)
      for (const key of ids) {
        try {
          await apply(key, state.after[key])
          const current = (await capture([key], policy)).before[key]
          if (JSON.stringify(current) !== JSON.stringify(state.after[key])) throw new Error('更改后的状态未通过验证。')
          record.outcomes.push(`${titles[key]}：已执行并确认系统值`) }
        catch (error) { record.status = 'partial'; record.outcomes.push(`${titles[key]}：未确认完成；后续项目未执行`); await atomicJSON(file, record); return { note: error.message + ' 原设置已保存，可在“更改记录与恢复”中恢复本次操作。', ...(await history()) } }
        await atomicJSON(file, record)
      }
      record.status = 'applied'; await atomicJSON(file, record)
      return { note: '已执行所选更改并保存恢复点；环境检查会重新验证。Claude 语言需重启客户端生效。', ...(await history()) }
    })
  }
  async function restore(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('恢复记录无效。')
    return locked(async () => {
      const file = join(root, id + '.json')
      if (!await regularFile(file)) throw new Error('恢复记录不存在。')
      const record = JSON.parse(await readFile(file, 'utf8'))
      if (record.version !== 2 || !Array.isArray(record.ids) || record.ids.some(id => !Object.hasOwn(titles,id))) throw new Error('恢复记录格式无效。')
      if (record.status === 'restored') return { note: '这次操作已恢复。', ...(await history()) }
      // Rewind in reverse chronological order to preserve settings that later repairs depend on.
      const records = await history()
      if (records.history.some(item => item.at > record.at && item.status !== 'restored')) throw new Error('请先恢复较新的更改，避免覆盖后续设置。')
      record.outcomes = []; record.status = 'restoring'; await atomicJSON(file,record)
      for (const key of [...record.ids].reverse()) {
        try {
          const policy = { timezone: record.after.timezone, locale: record.after.locale?.value,
            language: record.after.language?.value?.[0], networkService: record.after.ipv6?.service }
          const current = (await capture([key], policy)).before[key]
          const ownPartialTun = key === 'tun' && current.identity === record.before.tun.identity && current.clientID === record.before.tun.clientID
            && [record.before.tun.enable, record.after.tun.enable].includes(current.enable)
            && [record.before.tun.persisted, record.after.tun.persisted].includes(current.persisted)
          if (!ownPartialTun && JSON.stringify(current) !== JSON.stringify(record.before[key]) && JSON.stringify(current) !== JSON.stringify(record.after[key]))
            throw new Error('设置已被其他程序修改，已停止覆盖。')
          await apply(key, record.before[key])
          const restored = (await capture([key], policy)).before[key]
          if (JSON.stringify(restored) !== JSON.stringify(record.before[key])) throw new Error('恢复后的状态尚未通过验证。')
          record.outcomes.push(`${titles[key]}：原设置已恢复`) }
        catch { record.status = 'restore-partial'; record.outcomes.push(`${titles[key]}：恢复未完成，请重试或手动检查`); await atomicJSON(file, record); return { note: '部分恢复未完成，备份已保留。请查看结果后重试。', ...(await history()) } }
        await atomicJSON(file,record)
      }
      record.status = 'restored'; await atomicJSON(file,record)
      return { note: '已恢复本次操作前的设置；请查看重新检测结果。', ...(await history()) }
    })
  }
  return { preview, history, repair, restore }
}
