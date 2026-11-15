// Explicit, machine-specific intranet preservation. Never enabled by default.
export function applyCodexIntranet(input, options) {
  const { interfaceName, dnsServer, excludedNetworks, proxyName = 'Codex-Intranet', corporateDomains = [], attachmentProxy = '', applicationBundles = [], applicationDomains = [], applicationDnsServer = '', splitDomains = [], directDomains = [], openaiRouting = 'network' } = options
  if (!['network', 'intranet'].includes(openaiRouting)) throw new Error('Invalid OpenAI routing mode')
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,15}$/.test(interfaceName || '')) throw new Error('Invalid intranet interface')
  const ipv4 = value => typeof value === 'string' && value.split('.').length === 4
    && value.split('.').every(x => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255)
  if (!ipv4(dnsServer)) throw new Error('An intranet IPv4 DNS server is required')
  if (applicationDnsServer && (!ipv4(applicationDnsServer) || !applicationBundles.length)) throw new Error('Invalid application DNS server')
  if (!Array.isArray(excludedNetworks) || !excludedNetworks.length || excludedNetworks.some(value => {
    const [address, prefix, extra] = String(value).split('/')
    return extra !== undefined || !ipv4(address) || !/^\d+$/.test(prefix || '') || Number(prefix) < 8 || Number(prefix) > 32
  })) throw new Error('Explicit intranet subnets are required')
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,60}$/.test(proxyName) || ['DIRECT', 'REJECT', 'GLOBAL'].includes(proxyName)) throw new Error('Invalid intranet policy name')
  if (typeof attachmentProxy !== 'string' || (attachmentProxy && (!/^[a-zA-Z][a-zA-Z0-9-]{1,60}$/.test(attachmentProxy)
    || ['DIRECT', 'REJECT', 'GLOBAL', proxyName].includes(attachmentProxy)))) throw new Error('Invalid attachment proxy')
  if (!Array.isArray(applicationBundles) || applicationBundles.length > 32 || applicationBundles.some(path =>
    typeof path !== 'string' || !/^\/Applications\/[^/,\r\n\0]+\.app$/.test(path)
    || /\/(?:Claude|GuardNook)\.app$/i.test(path))) throw new Error('Invalid intranet application bundle')
  const config = JSON.parse(JSON.stringify(input))
  const openaiDomains = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com']
  const networkRouting = openaiRouting === 'network'
  // Retire only our own former OpenAI routes and DNS overrides. Subscription
  // rules and unrelated corporate/application exceptions remain in force.
  if (networkRouting) {
    const managedTargets = new Set([proxyName, proxyName + '-Apps', ...(attachmentProxy ? [attachmentProxy, 'REJECT'] : [])])
    config.rules = (config.rules || []).filter(rule => !openaiDomains.some(domain =>
      [...managedTargets].some(target => rule === `DOMAIN-SUFFIX,${domain},${target}`)))
    const policy = config.dns?.['nameserver-policy']
    for (const domain of openaiDomains) {
      const resolvers = policy?.['+.' + domain]
      if (Array.isArray(resolvers) && resolvers.length === 1
        && (resolvers[0] === `${dnsServer}#${interfaceName}`
          || (domain === 'oaiusercontent.com' && attachmentProxy
            && [attachmentProxy, 'REJECT'].some(target => resolvers[0] === `https://<IP>/dns-query#${target}`)))) delete policy['+.' + domain]
    }
    if (config.dns?.['fake-ip-filter']) config.dns['fake-ip-filter'] = config.dns['fake-ip-filter'].filter(value =>
      !openaiDomains.some(domain => value === '+.' + domain || value === `DOMAIN-SUFFIX,${domain},real-ip`))
  }
  if (config.mode && config.mode !== 'rule') throw new Error('Intranet preservation requires rule mode')
  const protectedDomains = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com', 'claudemcpclient.com', 'clau.de']
  if (!Array.isArray(corporateDomains) || corporateDomains.length > 64 || corporateDomains.some(domain =>
    typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || protectedDomains.some(h => domain === h || domain.endsWith('.' + h) || h.endsWith('.' + domain)))) throw new Error('Invalid corporate domain')
  if (!Array.isArray(applicationDomains) || applicationDomains.length > 64 || applicationDomains.some(domain =>
    typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || [...protectedDomains, 'oaiusercontent.com'].some(h => domain === h || domain.endsWith('.' + h) || h.endsWith('.' + domain)))) throw new Error('Invalid application domain')
  const domains = [...new Set([...(networkRouting ? [] : ['chatgpt.com', 'openai.com', 'oaistatic.com', ...(!attachmentProxy ? ['oaiusercontent.com'] : [])]), ...corporateDomains])]
  if (!Array.isArray(splitDomains) || splitDomains.length > 64 || splitDomains.some(domain =>
    typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || [...protectedDomains, 'oaiusercontent.com', ...domains, ...applicationDomains].some(h => domain === h || domain.endsWith('.' + h) || h.endsWith('.' + domain)))) throw new Error('Invalid split domain')
  if (!Array.isArray(directDomains) || directDomains.length > 64 || directDomains.some(domain =>
    typeof domain !== 'string' || domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || [...protectedDomains, 'oaiusercontent.com', ...domains, ...splitDomains, ...applicationDomains].some(h => domain === h || domain.endsWith('.' + h) || h.endsWith('.' + domain)))) throw new Error('Invalid direct domain')
  const proxy = { name: proxyName, type: 'direct', udp: true, 'ip-version': 'ipv4', 'interface-name': interfaceName }
  const existing = (config.proxies || []).find(p => p.name === proxyName)
  if (existing && (Object.keys(existing).length !== Object.keys(proxy).length || Object.keys(proxy).some(key => existing[key] !== proxy[key]))) throw new Error('Intranet proxy name already in use')
  if ((config['proxy-groups'] || []).some(p => p.name === proxyName)) throw new Error('Intranet proxy name already in use')
  config.proxies = (config.proxies || []).filter(p => p.name !== proxyName).concat(proxy)
  const appProxyName = proxyName + '-Apps'
  if (applicationBundles.length || splitDomains.length || directDomains.length) {
    // Public addresses cannot be forced into a split corporate tunnel. Let
    // Mihomo use the original physical network, with company subnets below
    // explicitly bound to the company interface instead.
    const appProxy = { name: appProxyName, type: 'direct', udp: true, 'ip-version': 'ipv4' }
    const existingApp = (config.proxies || []).find(p => p.name === appProxyName)
    if ((config['proxy-groups'] || []).some(p => p.name === appProxyName)
      || (existingApp && (Object.keys(existingApp).length !== Object.keys(appProxy).length || Object.keys(appProxy).some(k => existingApp[k] !== appProxy[k])))) throw new Error('Application proxy name already in use')
    config.proxies = config.proxies.filter(p => p.name !== appProxyName).concat(appProxy)
  }
  // Upload storage can be unavailable through the company gateway even when
  // ChatGPT and Codex work. Give it its own explicit route, including without TUN.
  const attachmentAvailable = (config.proxies || []).some(p => p.name === attachmentProxy)
    || (config['proxy-groups'] || []).some(p => p.name === attachmentProxy)
  const attachmentTarget = attachmentAvailable ? attachmentProxy : 'REJECT'
  const rules = (!networkRouting && attachmentProxy ? [`DOMAIN-SUFFIX,oaiusercontent.com,${attachmentTarget}`] : [])
    .concat([...new Set(splitDomains)].flatMap(domain => excludedNetworks
      .map(cidr => `AND,((DOMAIN-SUFFIX,${domain}),(IP-CIDR,${cidr})),${proxyName}`)
      .concat(`DOMAIN-SUFFIX,${domain},${appProxyName}`)))
    .concat([...new Set(applicationBundles)].flatMap(path => {
      const pattern = '^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'
      return excludedNetworks.map(cidr => `AND,((PROCESS-PATH-REGEX,${pattern}),(IP-CIDR,${cidr})),${proxyName}`)
        .concat(`PROCESS-PATH-REGEX,${pattern},${appProxyName}`)
    }))
    .concat(domains.map(domain => `DOMAIN-SUFFIX,${domain},${proxyName}`))
    .concat(corporateDomains.length ? excludedNetworks.map(cidr => `IP-CIDR,${cidr},${proxyName},no-resolve`) : [])
    .concat([...new Set(directDomains)].map(domain => `DOMAIN-SUFFIX,${domain},${appProxyName}`))
  const staleAttachmentRules = attachmentProxy ? [`DOMAIN-SUFFIX,oaiusercontent.com,${proxyName}`, 'DOMAIN-SUFFIX,oaiusercontent.com,REJECT'] : []
  const staleBoundRules = [...splitDomains, ...directDomains].map(domain => `DOMAIN-SUFFIX,${domain},${proxyName}`)
  const staleDirectBinding = rule => directDomains.some(domain => rule.startsWith(`AND,((DOMAIN-SUFFIX,${domain}),`) && rule.endsWith(`,${proxyName}`))
  // Moving a domain onto the OpenAI/company path must remove its previous
  // ordinary-network or split rules; an earlier fallback would otherwise win.
  const staleOrdinaryRules = domains.map(domain => `DOMAIN-SUFFIX,${domain},${appProxyName}`)
  const staleCompanySplit = rule => domains.some(domain => rule.startsWith(`AND,((DOMAIN-SUFFIX,${domain}),`) && rule.endsWith(`,${proxyName}`))
  const original = (config.rules || []).filter(rule => !rules.includes(rule) && !staleAttachmentRules.includes(rule) && !staleBoundRules.includes(rule) && !staleDirectBinding(rule) && !staleOrdinaryRules.includes(rule) && !staleCompanySplit(rule))
  // Keep the guard's existing domain/process rules ahead of these exceptions;
  // place them before a blanket mixed-port rule or final catch-all.
  const guardedGroups = new Set((config['proxy-groups'] || []).filter(group => group.proxies?.length === 2 && group.proxies.includes('REJECT')
    && group.proxies.some(name => (config.proxies || []).some(p => p.name === name && p.type === 'http' && p.server === '127.0.0.1' && p.username === 'claude-guard'))).map(group => group.name))
  let index = original.findIndex(rule => /^(?:IN-PORT,|AND,.*\(IN-PORT,|IN-TYPE,TUN,|AND,\(\(IN-TYPE,TUN\)|MATCH,)/i.test(rule) && !guardedGroups.has(rule.split(',').at(-1)))
  if (index < 0) index = original.length
  config.rules = [...original.slice(0, index), ...rules, ...original.slice(index)]
  config.dns ||= {}
  const filterMode = config.dns['fake-ip-filter-mode'] || 'blacklist'
  if (!['blacklist', 'rule'].includes(filterMode)) throw new Error('Unsupported fake-IP filter mode')
  const dnsDomains = [...new Set([...domains, ...splitDomains, ...applicationDomains, ...directDomains])]
  const filters = dnsDomains.map(domain => filterMode === 'rule' ? `DOMAIN-SUFFIX,${domain},real-ip` : `+.${domain}`)
  const oldAttachmentFilter = filterMode === 'rule' ? 'DOMAIN-SUFFIX,oaiusercontent.com,real-ip' : '+.oaiusercontent.com'
  config.dns['fake-ip-filter'] = [...new Set([...filters, ...(config.dns['fake-ip-filter'] || [])
    .filter(value => !attachmentProxy || value !== oldAttachmentFilter)])]
  config.dns['nameserver-policy'] ||= {}
  for (const domain of dnsDomains) config.dns['nameserver-policy'][`+.${domain}`] = [`${dnsServer}#${interfaceName}`]
  // Ordinary-network domains follow the system resolver rather than a chosen
  // tunnel or the global proxy DNS. Their sockets have no interface binding.
  for (const domain of directDomains) config.dns['nameserver-policy'][`+.${domain}`] = ['system']
  if (applicationDnsServer) for (const domain of applicationDomains) {
    if (domains.some(d => domain === d || domain.endsWith('.' + d) || d.endsWith('.' + domain))) throw new Error('Application DNS overlaps corporate DNS')
    config.dns['nameserver-policy'][`+.${domain}`] = [`${applicationDnsServer}#${appProxyName}`]
  }
  if (!networkRouting && attachmentProxy) config.dns['nameserver-policy']['+.oaiusercontent.com'] = [`https://<IP>/dns-query#${attachmentTarget}`]
  config.tun ||= {}
  config.tun['route-exclude-address'] = [...new Set([...(config.tun['route-exclude-address'] || []), ...excludedNetworks])]
  return config
}

export function composeCodexIntranetScript(source, options) {
  applyCodexIntranet({}, options) // Validate without running the user's script.
  if (source.includes('__guardNookIntranetMain')) throw new Error('Intranet wrapper already installed')
  return source + '\n// GuardNook: preserve this machine\'s explicitly chosen Codex intranet path.\n'
    + `const __guardNookIntranetMain = main;\nconst __applyCodexIntranet = ${applyCodexIntranet.toString()};\n`
    + `main = function(config) { return __applyCodexIntranet(__guardNookIntranetMain(config), ${JSON.stringify(options)}); };\n`
}
