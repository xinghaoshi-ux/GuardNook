import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

// RFC 5389 IPv4 Binding probe. Inspired by Claude Switcher's MIT STUN probe;
// see ../claude-switcher/NOTICE.md. This probes this process, not a browser ICE stack.
export function parseBinding(data, transaction) {
  if (data.length < 20 || data.readUInt16BE(0) !== 0x0101
    || data.readUInt32BE(4) !== 0x2112a442 || !data.subarray(8, 20).equals(transaction)) return null
  const end = 20 + data.readUInt16BE(2)
  if (end > data.length) return null
  for (let offset = 20; offset + 4 <= end;) {
    const type = data.readUInt16BE(offset), length = data.readUInt16BE(offset + 2)
    if (offset + 4 + length > end) return null
    const value = data.subarray(offset + 4, offset + 4 + length)
    if ([0x20, 1].includes(type) && value.length >= 8 && value[1] === 1) {
      const mask = type === 0x20 ? [0x21, 0x12, 0xa4, 0x42] : [0, 0, 0, 0]
      return [...value.subarray(4, 8)].map((byte, index) => byte ^ mask[index]).join('.')
    }
    offset += 4 + length + (4 - length % 4) % 4
  }
  return null
}
async function binding(host, port) {
  let timer, socket
  return new Promise(resolve => {
    let done = false
    const finish = result => {
      if (done) return
      done = true; clearTimeout(timer)
      if (socket) { try { socket.close() } catch {} }
      resolve(result)
    }
    timer = setTimeout(() => finish(null), 2500)
    lookup(host, { family: 4 }).then(({ address }) => {
      if (done) return
      const transaction = randomBytes(12), request = Buffer.alloc(20)
      request.writeUInt16BE(1, 0); request.writeUInt32BE(0x2112a442, 4); transaction.copy(request, 8)
      socket = dgram.createSocket('udp4')
      socket.on('error', () => finish(null))
      socket.on('message', (data, remote) => {
        if (remote.address !== address || remote.port !== port) return
        const result = parseBinding(data, transaction)
        if (result) finish(result)
      })
      socket.send(request, port, address, error => { if (error) finish(null) })
    }).catch(() => finish(null))
  })
}
export async function probeSTUN() {
  const addresses = await Promise.all([
    ['stun.miwifi.com', 3478], ['stun.chat.bilibili.com', 3478],
    ['stun.l.google.com', 19302], ['stun.cloudflare.com', 3478],
  ].map(([host, port]) => binding(host, port)))
  return [...new Set(addresses.filter(Boolean))]
}
