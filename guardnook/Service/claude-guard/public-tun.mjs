// Opt-in public routing for TUN and the ordinary local proxy ports.
// The existing Claude gate remains first; explicit intranet traffic stays local.
export function applyPublicTun(input, c, guardPrefixLength) {
  if (!c.publicTunExit && !c.publicProxyExit) return input
  const config = JSON.parse(JSON.stringify(input))
  const pinned = (config['proxy-groups'] || []).find(g => g.name === c.pinnedProxy)
  // Failed guard installation already contains Claude. Do not invent a route.
  if (!pinned) return config
  if (pinned.type !== 'select' || pinned.proxies?.length !== 1 || pinned.proxies[0] !== (c.frozenExitProxy || c.selectedProxy))
    throw new Error('Public exit must be immutable')
  const rules = config.rules || []
  // The kernel's own UDP transport (e.g. Hysteria2) must reach its upstream
  // without being captured by the public UDP rejection below. Match the exact
  // executable, after the mandatory Claude prefix; never allow an app by name.
  if (c.kernelProcessPath && (!/^\/(?:[^/]+\/)+(?:verge-mihomo|mihomo|clash-meta)$/.test(c.kernelProcessPath)
    || /[\r\n\0,]/.test(c.kernelProcessPath) || c.kernelProcessPath.split('/').some(x => x === '..' || x === '.')))
    throw new Error('Invalid proxy kernel path')
  const kernelRule = c.publicTunExit && c.kernelProcessPath
    ? [`AND,((IN-TYPE,TUN),(PROCESS-PATH,${c.kernelProcessPath}),(NETWORK,UDP)),DIRECT`] : []
  const exceptions = [...kernelRule, ...rules.filter(r => r === `DOMAIN-SUFFIX,oaiusercontent.com,${c.pinnedProxy}`),
    ...rules.filter(r => /,Codex-Intranet(?:-Apps)?(?:,no-resolve)?$/.test(r)),
    'DOMAIN-SUFFIX,local,DIRECT',
    ...['127.0.0.0/8', '<IP>/8', '<IP>/10', '<IP>/12', '<IP>/16',
      '<IP>/16', '<IP>/4', '<IP>/32']
      .map(cidr => `IP-CIDR,${cidr},DIRECT,no-resolve`)]
  const publicRules = c.publicTunExit ? [
    'AND,((IN-TYPE,TUN),(IP-CIDR6,::/0)),REJECT',
    'AND,((IN-TYPE,TUN),(NETWORK,UDP)),REJECT',
    `IN-TYPE,TUN,${c.pinnedProxy}`,
  ] : []
  if (c.publicProxyExit) {
    // The protected client and private probe listeners keep their own routes.
    const reserved = new Set([c.clientPort, c.probePort, c.gatewayPort, c.serverPort])
    const ports = [...new Set(['mixed-port', 'port', 'socks-port'].map(key => config[key]))]
      .filter(port => Number.isInteger(port) && port >= 1 && port <= 65535 && !reserved.has(port))
    if (!ports.length) throw new Error('Public proxy routing requires an ordinary proxy listening port')
    for (const port of ports) publicRules.push(
      `AND,((IN-PORT,${port}),(IP-CIDR6,::/0)),REJECT`,
      `AND,((IN-PORT,${port}),(NETWORK,UDP)),REJECT`,
      `IN-PORT,${port},${c.pinnedProxy}`,
    )
  }
  const extra = [...new Set([...exceptions, ...publicRules])]
  const reservedPorts = new Set([c.clientPort, c.probePort, c.gatewayPort, c.serverPort])
  const oldProxyRule = rule => {
    const port = rule.match(/^(?:IN-PORT,|AND,\(\(IN-PORT,)(\d+)/)?.[1]
    if (!port || reservedPorts.has(Number(port))) return false
    return rule === `IN-PORT,${port},${c.pinnedProxy}`
      || rule === `AND,((IN-PORT,${port}),(IP-CIDR6,::/0)),REJECT`
      || rule === `AND,((IN-PORT,${port}),(NETWORK,UDP)),REJECT`
  }
  const oldKernelRule = rule => /^AND,\(\(IN-TYPE,TUN\),\(PROCESS-PATH,.*\),\(NETWORK,UDP\)\),DIRECT$/.test(rule)
  // Keep the mandatory verified guard prefix at exactly its existing positions.
  config.rules = [...rules.slice(0, guardPrefixLength), ...extra,
    ...rules.slice(guardPrefixLength).filter(r => !extra.includes(r) && !oldProxyRule(r) && !oldKernelRule(r)
      && !/^AND,\(\(IN-TYPE,TUN\)/.test(r) && !/^IN-TYPE,TUN,/.test(r))]
  config.dns ||= {}
  // Node bootstrap must not recursively depend on the same proxy being resolved.
  config.dns['proxy-server-nameserver'] ||= config.dns['default-nameserver'] || ['<IP>']
  // Independent encrypted resolvers share the same immutable proxy. Neither
  // a DNS outage nor a slow persistent connection may cause a DIRECT fallback.
  config.dns.nameserver = ['<IP>', '<IP>'].map(ip => `https://${ip}/dns-query#${c.pinnedProxy}`)
  config.dns.fallback = []
  config.dns.ipv6 = false
  config.ipv6 = false
  // Neither TUN nor the operating system's proxy switch is enabled here.
  return config
}
