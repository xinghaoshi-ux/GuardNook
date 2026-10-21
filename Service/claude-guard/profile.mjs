import { DEFAULT_CONFIG, validateConfig } from './config.mjs'
import { coverageRules } from './coverage.mjs'
import { tunRequiredRules } from './tun-connections.mjs'

// Kept self-contained: the same function runs inside Clash Verge's JS engine.
export function applyClaudeGuard(input, options) {
  const c = options
  if (!c.proxyPassword) throw new Error('Private local proxy credentials are required')
  const config = JSON.parse(JSON.stringify(input))
  const proxies = config.proxies || []
  const groups = config['proxy-groups'] || []
  const pinned = proxies.find(p => p.name === c.pinnedProxy) || (c.selectedProxy && groups.find(g => g.name === c.pinnedProxy))
  if (!pinned) throw new Error('Pinned Claude proxy is missing')
  if (c.selectedProxy) {
    const exactFilter = '^' + c.selectedProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
    const oneNode = pinned.proxies?.length === 1 && pinned.proxies[0] === (c.frozenExitProxy || c.selectedProxy)
    const providerNode = !pinned.proxies?.length && Array.isArray(pinned.use) && pinned.use.length > 0
      && pinned.use.every(name => Object.hasOwn(config['proxy-providers'] || {}, name))
      && pinned.filter === exactFilter && pinned['empty-fallback'] === 'REJECT'
    if (pinned.type !== 'select' || pinned['disable-udp'] !== true || !(oneNode || providerNode))
      throw new Error('Pinned selector must contain only the chosen node and disable UDP')
  } else if (pinned.udp !== false) throw new Error('Pinned Claude proxy must disable UDP')
  const group = groups.find(g => g.name === c.policyGroup)
  if (!group || group.type !== 'select') throw new Error('Claude selector is missing')
  if (group.proxies.some(name => ![c.pinnedProxy, c.gatewayProxy, 'REJECT'].includes(name)))
    throw new Error('Claude selector contains an unexpected fallback')
  const existingGateway = proxies.find(p => p.name === c.gatewayProxy)
  if (existingGateway && (existingGateway.type !== 'http' || existingGateway.server !== '127.0.0.1' || existingGateway.port !== c.gatewayPort))
    throw new Error('Gateway proxy name is already in use')
  config.proxies = proxies.filter(p => p.name !== c.gatewayProxy).concat({
    name: c.gatewayProxy, type: 'http', server: '127.0.0.1', port: c.gatewayPort,
    udp: false,
    username: c.proxyUser, password: c.proxyPassword,
  })
  group.proxies = ['REJECT', c.gatewayProxy]
  const listeners = config.listeners || []
  const client = listeners.find(l => Number(l.port) === c.clientPort)
  if (!client || client.listen !== '127.0.0.1' || client.type !== 'http' || client.rule !== undefined || ![undefined, c.policyGroup, ...(c.ownedProtection ? [c.gatewayProxy] : [])].includes(client.proxy))
    throw new Error('Expected loopback Claude HTTP client listener is missing')
  // Use the original global rules for ordinary/intranet requests on this port.
  delete client.proxy
  delete client.rule
  if (c.ownedProtection) client.proxy = c.gatewayProxy
  const probeName = 'Claude-guard-probe'
  if (listeners.some(l => Number(l.port) === c.probePort && l.name !== probeName))
    throw new Error('Probe port is already in use')
  const oldProbe = listeners.find(l => l.name === probeName)
  if (oldProbe && (oldProbe.proxy !== c.pinnedProxy || oldProbe.listen !== '127.0.0.1' || oldProbe.type !== 'http' || Number(oldProbe.port) !== c.probePort))
    throw new Error('Existing probe listener has an unsafe route')
  config.listeners = listeners.filter(l => l.name !== probeName).concat({
    name: probeName, type: 'http', listen: '127.0.0.1', port: c.probePort,
    users: [{ username: c.proxyUser, password: c.proxyPassword }], proxy: c.pinnedProxy,
  })
  const domains = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com']
  const googleHosts = ['accounts.google.com', 'google.com', 'www.google.com']
  const authHosts = c.guardGoogleAuth === false ? [] : googleHosts
  const prefix = domains.map(d => `DOMAIN-SUFFIX,${d},${c.policyGroup}`)
    .concat(authHosts.map(h => `DOMAIN,${h},${c.policyGroup}`))
    .concat(coverageRules(c)).concat(tunRequiredRules(c))
  const retiredGoogle = c.guardGoogleAuth === false ? googleHosts.map(h => `DOMAIN,${h},${c.policyGroup}`) : []
  config.rules = prefix.concat((config.rules || []).filter(r => !prefix.includes(r) && !retiredGoogle.includes(r)))
  if (c.coverageVersion === 1) {
    config['find-process-mode'] = 'strict'
    // Only add the protected DNS policies; retain ordinary/intranet DNS and TUN.
    config.dns ||= {}
    config.dns['nameserver-policy'] ||= {}
    for (const domain of [...domains, 'claudemcpcontent.com']) {
      // Resolving the private probe must not depend on opening the guard gate.
      // DNS uses the same immutable exit, while account traffic stays gated.
      config.dns['nameserver-policy'][`+.${domain}`] = [`https://1.1.1.1/dns-query#${c.pinnedProxy}`]
    }
  }
  if (config.mode && config.mode !== 'rule') throw new Error('Rule mode is required')
  return config
}

// Add a private single-node selector without copying credentials or changing the
// chosen node. Named provider nodes are supported by Mihomo at config load time.
export function prepareSelectedProfile(input, c) {
  if (!c.selectedProxy) return input
  const config = JSON.parse(JSON.stringify(input))
  config['proxy-groups'] ||= []
  config.listeners ||= []
  const managedNames = [c.pinnedProxy, c.policyGroup, c.gatewayProxy]
  if ((config.proxies || []).some(p => managedNames.includes(p.name))
    || config['proxy-groups'].some(p => managedNames.includes(p.name)))
    throw new Error('GuardNook names already exist; start with the original pre-guard script')
  if (config.listeners.some(l => Number(l.port) === c.clientPort))
    throw new Error('GuardNook client port is already in use')
  const chosenGroup = config['proxy-groups'].find(p => p.name === c.selectedProxy)
  if (chosenGroup) throw new Error('Choose a concrete node, not a proxy group')
  if (!(config.proxies || []).some(p => p.name === c.selectedProxy) && !Object.keys(config['proxy-providers'] || {}).length)
    throw new Error('Chosen node does not exist in this profile')
  const inline = (config.proxies || []).some(p => p.name === c.selectedProxy)
  if (c.frozenExitProxy) {
    const aliases = [c.frozenExitProxy, ...c.upstreamChain]
    const originals = c.frozenSources.map(name => {
      const node = (config.proxies || []).find(p => p.name === name)
      if (!node || node.type === 'direct' || node.type === 'reject') throw new Error('Frozen chain source is missing')
      return node
    })
    for (const name of aliases) {
      if ((config.proxies || []).some(p => p.name === name) || config['proxy-groups'].some(p => p.name === name)) throw new Error('Frozen node name is already in use')
    }
    originals.forEach((node, index) => {
      const clone = { ...node, name: aliases[index], udp: false }
      const next = node['dialer-proxy']
      let bound = next
      const seen = new Set()
      while (c.upstreamBindings[bound]) { if (seen.has(bound)) throw new Error('Cyclic upstream bindings'); seen.add(bound); bound = c.upstreamBindings[bound] }
      if (index + 1 < aliases.length) {
        if (bound !== c.frozenSources[index + 1]) throw new Error('Upstream chain changed since selection')
        clone['dialer-proxy'] = aliases[index + 1]
      } else if (next) throw new Error('Unpinned final upstream')
      else delete clone['dialer-proxy']
      config.proxies.push(clone)
    })
  }
  const pinned = inline
    ? { name: c.pinnedProxy, type: 'select', proxies: [c.frozenExitProxy || c.selectedProxy], 'disable-udp': true }
    : { name: c.pinnedProxy, type: 'select', use: Object.keys(config['proxy-providers']),
        filter: '^' + c.selectedProxy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
        'empty-fallback': 'REJECT', 'disable-udp': true }
  config['proxy-groups'].push(
    pinned,
    { name: c.policyGroup, type: 'select', proxies: ['REJECT', c.gatewayProxy], 'disable-udp': true }
  )
  config.listeners.push({ name: 'GuardNook-client', type: 'http', listen: '127.0.0.1', port: c.clientPort })
  return config
}

export function composeProfileScript(originalSource, config = DEFAULT_CONFIG) {
  const c = validateConfig(config)
  if (!c.proxyPassword) throw new Error('Private local proxy credentials are required')
  // The extension needs proxy credentials, but never the controller secret.
  const profileOptions = Object.fromEntries(['expectedIP', 'policyGroup', 'pinnedProxy', 'gatewayProxy', 'selectedProxy',
    'clientPort', 'probePort', 'gatewayPort', 'proxyUser', 'proxyPassword', 'coverageVersion', 'targetPlatform', 'frozenExitProxy', 'frozenSources', 'upstreamChain', 'upstreamBindings', 'requireTun', 'guardGoogleAuth'].map(key => [key, c[key]]))
  if (originalSource.includes('__previousClaudeMain')) throw new Error('Use the original script, not an already generated guard script')
  return `// Claude guard: generated offline. Preserve this script's original behavior.\n`
    + `const __previousClaudeMain = (() => {\n${originalSource}\nreturn main;\n})();\n`
    + `const __applyClaudeGuard = ${applyClaudeGuard.toString()};\n`
    + `const coverageRules = ${coverageRules.toString()};\n`
    + `const tunRequiredRules = ${tunRequiredRules.toString()};\n`
    + `const __prepareSelectedProfile = ${prepareSelectedProfile.toString()};\n`
    + `function main(config) {\n  const value = __previousClaudeMain(config);\n`
    + `  return __applyClaudeGuard(__prepareSelectedProfile(value, ${JSON.stringify(profileOptions)}), ${JSON.stringify(profileOptions)});\n}\n`
}
