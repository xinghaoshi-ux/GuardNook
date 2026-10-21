import http from 'node:http'

export function controllerOptions(config) {
  const headers = config.controllerSecret ? { authorization: `Bearer ${config.controllerSecret}` } : {}
  if (config.controllerURL) {
    const url = new URL(config.controllerURL)
    return { hostname: url.hostname === '[::1]' ? '::1' : url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, port: Number(url.port), headers }
  }
  return { socketPath: config.controllerSocket, headers }
}

export function createController(config) {
  const request = (path, method = 'GET', body, { timeoutMs = config.timeoutMs } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      ...controllerOptions(config), path, method,
      headers: { ...controllerOptions(config).headers, ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        data += chunk
        if (data.length > 4 * 1024 * 1024) req.destroy(new Error('Controller response too large'))
      })
      res.on('error', reject)
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Controller HTTP ${res.statusCode}`)); return
        }
        try { resolve(data ? JSON.parse(data) : null) } catch { reject(new Error('Invalid controller JSON')) }
      })
    })
    const deadline = setTimeout(() => req.destroy(new Error('Controller timeout')), timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end(payload)
  })
  return { request, select(name) {
    if (![config.gatewayProxy, 'REJECT'].includes(name)) throw new Error('Unsafe selector choice')
    return request(`/proxies/${encodeURIComponent(config.policyGroup)}`, 'PUT', { name })
  } }
}
