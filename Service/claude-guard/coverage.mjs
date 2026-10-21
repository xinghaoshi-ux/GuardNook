// Versioned additions; older installed guards retain their original contract.
// Shared telemetry/CDN providers are deliberately not global routing rules.
export function coverageRules(c) {
  if (c.coverageVersion !== 1) return []
  const policy = c.policyGroup
  const names = c.targetPlatform === 'win32'
    ? ['Claude.exe', 'claude.exe', 'claude-code.exe', 'Claude Helper.exe']
    : ['Claude', 'Claude Helper', 'Claude Helper (Renderer)', 'Claude Helper (GPU)', 'Claude Helper (Plugin)', 'claude', 'claude-code']
  const applicationPath = c.targetPlatform === 'win32'
    ? '(?i).*[\\\\/](claude|claude-code)[\\\\/].*'
    : '.*(/\\.local/share/claude/versions/|/Claude\\.app/Contents/).*'
  return [
    `DOMAIN-SUFFIX,claudemcpcontent.com,${policy}`,
    'DOMAIN,localhost,DIRECT',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR6,::1/128,DIRECT,no-resolve',
    'AND,((NETWORK,UDP),(OR,((DOMAIN-SUFFIX,claude.ai),(DOMAIN-SUFFIX,claude.com),(DOMAIN-SUFFIX,anthropic.com),(DOMAIN-SUFFIX,claudeusercontent.com),(DOMAIN-SUFFIX,claudemcpcontent.com)))),REJECT',
    ...names.map(name => `AND,((PROCESS-NAME,${name}),(NETWORK,UDP)),REJECT`),
    `AND,((PROCESS-PATH-REGEX,${applicationPath}),(NETWORK,UDP)),REJECT`,
    ...names.map(name => `PROCESS-NAME,${name},${policy}`),
    `PROCESS-PATH-REGEX,${applicationPath},${policy}`,
    // Official inbound prefixes. The /21 is Anthropic's outbound range.
    `IP-CIDR,160.79.104.0/23,${policy},no-resolve`,
    // A fixed IPv4 exit is not evidence of the same IPv6 exit.
    'IP-CIDR6,2607:6bc0::/48,REJECT,no-resolve',
    ...(c.ownedProtection ? [`IN-PORT,${c.clientPort},${policy}`] : []),
  ]
}
