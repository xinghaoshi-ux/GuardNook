import net from 'node:net'

export function proxyAuthorization(c) {
  return c.proxyPassword ? `Basic ${Buffer.from(`${c.proxyUser}:${c.proxyPassword}`).toString('base64')}` : ''
}

export function connectTunnel(c, authority, port = c.probePort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const deadline = setTimeout(() => socket.destroy(new Error('Upstream timeout')), c.timeoutMs)
    let header = Buffer.alloc(0)
    const fail = err => { clearTimeout(deadline); socket.destroy(); reject(err) }
    const onClose = () => fail(new Error('Upstream closed before tunnel establishment'))
    socket.once('error', fail)
    socket.once('close', onClose)
    socket.once('connect', () => {
      const auth = proxyAuthorization(c)
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`)
    })
    const onData = chunk => {
      header = Buffer.concat([header, chunk])
      if (header.length > 16384) { fail(new Error('Upstream header too large')); return }
      const end = header.indexOf('\r\n\r\n')
      if (end < 0) return
      clearTimeout(deadline)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      socket.removeListener('close', onClose)
      if (!/^HTTP\/1\.[01] 200\b/.test(header.subarray(0, end).toString('ascii'))) {
        fail(new Error('Upstream refused tunnel')); return
      }
      socket.pause()
      const rest = header.subarray(end + 4)
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}
