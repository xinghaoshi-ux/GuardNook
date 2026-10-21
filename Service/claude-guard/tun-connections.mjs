export function tunRequiredRules(c) {
  if (!c.requireTun) return []
  return ['clau.de', 'claudemcpclient.com', 'hcaptcha.com', 'hcaptcha.net', 'challenges.cloudflare.com']
    .map(host => `DOMAIN-SUFFIX,${host},${c.policyGroup}`)
    .concat(['anthropic.auth0.com', 'servd-anthropic-website.b-cdn.net', 'anthropic.com.cdn.cloudflare.net', 'anthropic-com.ghost.io']
      .map(host => `DOMAIN,${host},${c.policyGroup}`))
}

export async function closeClaudeConnections(c, controller) {
  const snapshot = await controller.request('/connections')
  const domains = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com', 'claudemcpclient.com', 'clau.de',
    ...tunRequiredRules(c).filter(r => r.startsWith('DOMAIN-SUFFIX,')).map(r => r.split(',')[1])]
  const exactHosts = tunRequiredRules(c).filter(r => r.startsWith('DOMAIN,')).map(r => r.split(',')[1])
  const process = /^(Claude(?: Helper(?: \((?:Renderer|GPU|Plugin)\))?)?|claude-code)(?:\.exe)?$/i
  const path = /(?:\/Claude\.app\/Contents\/|\/\.local\/share\/claude\/versions\/|\/Application Support\/Claude\/claude-code\/|[\\/](?:claude|claude-code)[\\/])/i
  const ids = (snapshot.connections || []).filter(row => {
    const m = row.metadata || {}, host = (m.host || m.sniffHost || '').toLowerCase()
    return row.chains?.includes(c.gatewayProxy) || row.chains?.includes(c.policyGroup)
      || exactHosts.includes(host) || domains.some(d => host === d || host.endsWith('.' + d)) || process.test(m.process || '') || path.test(m.processPath || '')
  }).map(row => row.id).filter(id => typeof id === 'string' && id.length > 0)
  await Promise.all(ids.map(id => controller.request('/connections/' + encodeURIComponent(id), 'DELETE')))
  return ids.length
}
