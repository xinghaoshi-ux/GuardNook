import { readFile, rename, rm, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createController } from './controller.mjs'
import { desktopRoot, regularFile, privateDirectory, atomicJSON, readInput, reply } from './desktop-common.mjs'
import { validateConfig } from './config.mjs'
import { isMainModule } from './entry.mjs'
export function createMaintenance({ home = homedir(), controllerFor = createController } = {}) {
  const root = desktopRoot(home), disabled = join(root, 'disabled-connections'), configFile = join(root, 'config.json')
  async function summary() {
    const configured = await regularFile(configFile), snapshots = []
    await privateDirectory(disabled)
    for (const name of await readdir(disabled)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const file = join(disabled,name)
      if (!await regularFile(file)) continue
      try { const item = JSON.parse(await readFile(file,'utf8')); snapshots.push({ id: name.slice(0,-5), at: item.at }) } catch {}
    }
    return { configured, external: configured && JSON.parse(await readFile(configFile, 'utf8')).serviceMode === 'existing',
      latestConnection: snapshots.sort((a,b)=>b.at-a.at)[0]?.id || null }
  }
  async function detach(confirmed) {
    if (confirmed !== true) throw new Error('请先确认解除连接及其影响。')
    const source = JSON.parse(await readFile(configFile, 'utf8')), c = validateConfig(source)
    // This app may block its own route, but never tears down an externally managed service.
    if (source.serviceMode !== 'existing') await controllerFor(c).select('REJECT')
    await privateDirectory(disabled)
    const id = randomUUID(), snapshot = { at: Date.now(), config: source, setup: null }
    const setupFile = join(root,'SETUP.json')
    if (await regularFile(setupFile)) snapshot.setup = JSON.parse(await readFile(setupFile,'utf8'))
    await atomicJSON(join(disabled,id+'.json'), snapshot)
    await atomicJSON(join(root,'monitor.json'), { version:1,mode:'monitor',at:Date.now(),detached:id })
    await rename(configFile,join(disabled,id+'.config'))
    let originalPath = null
    const candidate = snapshot.setup?.originalPath
    if (typeof candidate === 'string' && resolve(candidate).startsWith(resolve(join(root,'Profiles'))+sep)
      && await regularFile(candidate)) originalPath = candidate
    return { note: source.serviceMode === 'existing'
      ? '已解除本面板连接。原有独立守护继续运行；如要卸载原守护，请使用它的恢复流程。'
      : '本应用的保护通道已阻断并停止接入。请先在代理客户端恢复原始扩展脚本并重载，再移除 GuardNook；本地日志与环境备份继续保留。',
      originalPath, maintenance: await summary() }
  }
  async function restore(id, confirmed) {
    if (confirmed !== true || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('请确认要恢复的连接。')
    if (await regularFile(configFile)) throw new Error('已有连接配置，未覆盖；请先检查当前连接。')
    const file = join(disabled,id+'.json')
    if (!await regularFile(file)) throw new Error('连接恢复点不存在。')
    const snapshot = JSON.parse(await readFile(file,'utf8'))
    validateConfig(snapshot.config)
    if (snapshot.setup) await atomicJSON(join(root,'SETUP.json'),snapshot.setup)
    await atomicJSON(configFile,{ ...snapshot.config,startProtected:false })
    await rm(join(root,'monitor.json'),{force:true})
    return { note:'连接配置已恢复；请到守护页明确启用并重新验证保护。', maintenance:await summary() }
  }
  return { summary,detach,restore }
}
if (isMainModule(import.meta.url)) {
  try {
    const input=await readInput(), manager=createMaintenance()
    if(input.action==='summary') reply({maintenance:await manager.summary()})
    else if(input.action==='detach') reply(await manager.detach(input.confirmed))
    else if(input.action==='restore') reply(await manager.restore(input.id,input.confirmed))
    else throw new Error('未知维护操作。')
  } catch(error) { reply({error:error.code?'维护未完成，请保留原设置后重试。':error.message});process.exitCode=1 }
}
