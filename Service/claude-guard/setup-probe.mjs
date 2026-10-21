import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { connectTunnel } from './tunnel.mjs'
import { atomicJSON, privateDirectory, regularFile } from './desktop-common.mjs'
import { readFile } from 'node:fs/promises'
export const fingerprint = input => createHash('sha256').update(JSON.stringify([
  input.controllerURL || '', input.controllerSocket || '', input.controllerSecret || '', input.selectedProxy,
  input.fixedUpstreams || {}, input.upstreamChain || [], input.resolvedUpstream || [],
])).digest('hex')
export function validateSetupRoute(snapshot, input, sourcePort, inboundPort) {
  const row = snapshot.connections?.find(row => Number(row.metadata?.sourcePort) === sourcePort
    && Number(row.metadata?.inboundPort) === inboundPort && row.metadata?.host === 'claude.ai')
  if (!row?.chains?.includes(input.selectedProxy) || row.chains.some(name => ['DIRECT', 'REJECT', 'GLOBAL'].includes(name)))
    throw new Error('当前代理路径没有经过所选节点。请先在代理客户端为 Claude 选择该节点，或明确选择手动填写出口。')
  return row.chains
}
async function sample(input, controller, port) {
  let raw, secure, req
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 })
  const timer = setTimeout(() => { req?.destroy(new Error('检测超时')); secure?.destroy(); raw?.destroy() }, 12000)
  try {
    raw = await connectTunnel({ timeoutMs: 10000 }, 'claude.ai:443', port)
    const sourcePort = raw.localPort
    secure = tls.connect({ socket: raw, servername: 'claude.ai', rejectUnauthorized: true })
    agent.createConnection = () => secure
    const body = await new Promise((resolve, reject) => {
      req = https.request({ hostname: 'claude.ai', path: '/cdn-cgi/trace', agent,
        headers: { 'accept-encoding': 'identity', 'user-agent': 'GuardNook-Setup/1' } }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error('Claude 出口接口未返回成功响应')); return }
        let body = ''; response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(new Error('检测响应过大')) })
        response.on('error', reject); response.on('end', () => resolve(body))
      })
      secure.once('error', reject); req.once('error', reject); req.end()
    })
    validateSetupRoute(await controller.request('/connections'), input, sourcePort, port)
    const fields = Object.fromEntries(body.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    if (isIP(fields.ip || '') !== 4) throw new Error('本次未取得 IPv4 出口。')
    return { ip: fields.ip, country: fields.loc || '' }
  } finally { clearTimeout(timer); agent.destroy(); secure?.destroy(); raw?.destroy() }
}
export async function measureSetup(root, input, controller, takeSample = sample) {
  const config = await controller.request('/configs')
  const port = config['mixed-port'] || config.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('客户端没有启用本机 HTTP / 混合代理端口，请使用手动出口配置。')
  const samples = []
  for (let i = 0; i < 3; i++) samples.push(await takeSample(input, controller, port))
  if (!samples[0]?.ip || samples.some(value => value.ip !== samples[0].ip)) throw new Error('连续三次出口不同，不能将此链路确认为固定出口。')
  const id = randomUUID(), at = Date.now(), record = { id, at, fingerprint: fingerprint(input), ...samples[0] }
  await privateDirectory(root); await privateDirectory(join(root, 'setup-probes'))
  await atomicJSON(join(root, 'setup-probes', id + '.json'), record)
  return { measured: { id, at, ip: record.ip, country: record.country, samples: 3 } }
}
export async function verifySetupConfirmation(root, input) {
  if (input.setupVersion !== 2) return // Existing integrations retain their contract.
  if (input.confirmChanges !== true) throw new Error('请先在预览页确认本次配置。')
  if (input.manualExit === true) {
    if (input.confirmManualExit !== true) throw new Error('请确认手动填写的出口尚未由向导实测。')
    return
  }
  if (typeof input.probeID !== 'string' || !/^[a-f0-9-]{36}$/.test(input.probeID)) throw new Error('请先检测并确认所选节点的实际出口。')
  const file = join(root, 'setup-probes', input.probeID + '.json')
  if (!await regularFile(file)) throw new Error('未找到出口检测记录。')
  const record = JSON.parse(await readFile(file, 'utf8'))
  if (record.fingerprint !== fingerprint(input) || record.ip !== input.expectedIP
    || Date.now() - record.at > 5 * 60 * 1000 || record.at > Date.now() + 1500)
    throw new Error('节点、接口或目标已改变，或检测已过期，请重新检测。')
}
