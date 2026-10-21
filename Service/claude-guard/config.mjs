import { isIP } from 'node:net'

export const EXPECTED_IP = '203.0.113.10'
export const CLAUDE_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com']
export const GOOGLE_AUTH_HOSTS = ['accounts.google.com', 'google.com', 'www.google.com']

export const DEFAULT_CONFIG = Object.freeze({
  expectedIP: EXPECTED_IP,
  controllerSocket: '/tmp/verge/verge-mihomo.sock',
  controllerURL: '',
  controllerSecret: '',
  selectedProxy: '',
  coverageVersion: 0,
  targetPlatform: 'darwin',
  frozenExitProxy: '',
  frozenSources: [],
  upstreamBindings: {},
  upstreamChain: [],
  policyGroup: 'Claude-203.0.113.10',
  pinnedProxy: 'Claude-exit-pinned',
  pinnedEntry: 'Claude-entry-pinned',
  gatewayProxy: 'Claude-guard-gateway',
  gatewayPort: 17904,
  probePort: 17903,
  clientPort: 7901,
  serverPort: 17891,
  intervalMs: 3000,
  timeoutMs: 10000,
  leaseMs: 20000,
  recoverySamples: 3,
  publicTunExit: false,
  publicProxyExit: false,
  requireTun: false,
  guardGoogleAuth: true,
  proxyUser: 'claude-guard',
  proxyPassword: '',
})

export function validateConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input }
  if (!['darwin', 'win32'].includes(c.targetPlatform)) throw new Error('Unsupported target platform')
  if (typeof c.publicTunExit !== 'boolean' || typeof c.publicProxyExit !== 'boolean') throw new Error('Invalid public egress setting')
  if (typeof c.requireTun !== 'boolean') throw new Error('Invalid TUN requirement')
  if (typeof c.guardGoogleAuth !== 'boolean') throw new Error('Invalid Google authentication routing')
  if (![0, 1].includes(c.coverageVersion)) throw new Error('Unsupported coverage version')
  if (isIP(c.expectedIP) !== 4)
    throw new Error('Expected exit must be an IPv4 address')
  for (const k of ['gatewayPort', 'probePort', 'clientPort', 'serverPort']) {
    if (!Number.isInteger(c[k]) || c[k] < 1024 || c[k] > 65535)
      throw new Error(`Invalid ${k}`)
  }
  if (new Set([c.gatewayPort, c.probePort, c.clientPort, c.serverPort]).size !== 4)
    throw new Error('Gateway, probe, client and dashboard ports must differ')
  for (const k of ['policyGroup', 'pinnedProxy', 'pinnedEntry', 'gatewayProxy']) {
    if (typeof c[k] !== 'string' || !c[k] || /[\r\n,]/.test(c[k]))
      throw new Error(`Invalid ${k}`)
  }
  if (new Set([c.policyGroup, c.pinnedProxy, c.gatewayProxy]).size !== 3
    || [c.policyGroup, c.pinnedProxy, c.gatewayProxy].some(x => ['DIRECT', 'REJECT', 'GLOBAL'].includes(x)))
    throw new Error('Proxy and policy names must differ')
  if (typeof c.controllerURL !== 'string') throw new Error('Invalid controller URL')
  if (c.controllerURL) {
    const url = new URL(c.controllerURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.port)
      throw new Error('Controller must be a loopback HTTP address with an explicit port')
    c.controllerURL = url.origin
  } else if (typeof c.controllerSocket !== 'string' || !c.controllerSocket.startsWith('/') || /[\r\n\0]/.test(c.controllerSocket))
    throw new Error('An absolute local controller socket is required')
  if (typeof c.controllerSecret !== 'string' || /[\r\n\0]/.test(c.controllerSecret) || c.controllerSecret.length > 1024)
    throw new Error('Invalid controller secret')
  const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\r\n,\0]/.test(name)
  if (c.frozenExitProxy && (!validName(c.frozenExitProxy) || ['DIRECT', 'REJECT', 'GLOBAL', c.pinnedProxy, c.gatewayProxy].includes(c.frozenExitProxy))) throw new Error('Invalid frozen exit')
  if (!Array.isArray(c.frozenSources) || c.frozenSources.length > 9 || c.frozenSources.some(name => !validName(name))) throw new Error('Invalid frozen sources')
  if (!c.upstreamBindings || typeof c.upstreamBindings !== 'object' || Array.isArray(c.upstreamBindings)
    || Object.entries(c.upstreamBindings).some(([group, selected]) => !validName(group) || !validName(selected))) throw new Error('Invalid upstream bindings')
  if (c.frozenExitProxy && (c.frozenSources[0] !== c.selectedProxy || c.frozenSources.length !== c.upstreamChain.length + 1)) throw new Error('Incomplete frozen chain')
  if (c.selectedProxy && (!validName(c.selectedProxy) || [c.policyGroup, c.pinnedProxy, c.gatewayProxy, 'DIRECT', 'REJECT', 'GLOBAL'].includes(c.selectedProxy)))
    throw new Error('Select a distinct concrete upstream node')
  if (!Array.isArray(c.upstreamChain) || c.upstreamChain.length > 8
    || c.upstreamChain.some(name => !validName(name) || ['DIRECT', 'REJECT', 'GLOBAL', c.gatewayProxy].includes(name)))
    throw new Error('Invalid pinned upstream chain')
  c.upstreamChain = Object.freeze([...new Set(c.upstreamChain)])
  for (const k of ['intervalMs', 'timeoutMs', 'leaseMs']) {
    if (!Number.isInteger(c[k]) || c[k] < 100 || c[k] > 60000)
      throw new Error(`Invalid ${k}`)
  }
  if (c.leaseMs < c.timeoutMs || c.leaseMs > 30000)
    throw new Error('Lease must be bounded and at least the probe timeout')
  if (!Number.isInteger(c.recoverySamples) || c.recoverySamples < 2 || c.recoverySamples > 10)
    throw new Error('Recovery requires 2–10 consecutive samples')
  if (c.proxyUser !== 'claude-guard' || typeof c.proxyPassword !== 'string'
    || (c.proxyPassword && !/^[a-f0-9]{64}$/.test(c.proxyPassword)))
    throw new Error('Invalid local proxy credentials')
  return Object.freeze(c)
}

export function isClaudeHost(host = '') {
  const h = host.toLowerCase().replace(/\.$/, '')
  return CLAUDE_DOMAINS.some(d => h === d || h.endsWith(`.${d}`))
}
