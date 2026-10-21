import { join } from 'node:path'
import { homedir } from 'node:os'
import { lstat } from 'node:fs/promises'

export const CLIENTS = Object.freeze([
  { id: 'verge', title: 'Clash Verge Rev', support: '本机适配', socket: '/tmp/verge/verge-mihomo.sock', persistentTun: true },
  { id: 'mihomo', title: '其他 Mihomo 客户端', support: '标准本机控制接口；规则需按客户端导入', socket: '', persistentTun: false },
])
export function clientAdapter(id = 'verge', home = homedir()) {
  const entry = CLIENTS.find(item => item.id === id)
  if (!entry) throw new Error('请选择已支持的代理客户端。')
  return { ...entry, tunFile: id === 'verge' ? join(home, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/verge.yaml') : null }
}
export async function localEndpoints(input = {}) {
  if (input.clientID !== undefined && !CLIENTS.some(item => item.id === input.clientID)) throw new Error('未知客户端。')
  const sockets = input.clientID === 'mihomo' ? [] : ['/tmp/verge/verge-mihomo.sock']
  const values = []
  for (const socket of sockets) {
    // Known path only; never scan the network or read other clients' credentials.
    try { const stat = await lstat(socket); if (!stat.isSocket() || stat.isSymbolicLink()) continue } catch { continue }
    values.push({ controllerSocket: socket, controllerURL: '', clientID: 'verge' })
  }
  for (const port of [9090, 9097]) values.push({ controllerSocket: '', controllerURL: `http://127.0.0.1:${port}`, clientID: input.clientID || 'mihomo' })
  return values
}
export function parseNetworkServices(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('*') && !line.startsWith('An asterisk'))
}
export async function activeNetworkServices(execute) {
  const listed = await execute('/usr/sbin/networksetup', ['-listallnetworkservices'])
  const names = parseNetworkServices(listed.text)
  const values = await Promise.all(names.map(async name => {
    const result = await execute('/usr/sbin/networksetup', ['-getinfo', name])
    return { name, available: result.ok, active: /^IP address:\s*(?!none\b)\d/im.test(result.text), info: result.text }
  }))
  return values.filter(value => value.available).sort((a, b) => Number(b.active) - Number(a.active))
}
