// Independent of node names: even a broken subscription must not send Claude
// to its normal MATCH policy. Does not claim to filter traffic outside Clash.
export function containClaude(input) {
  const config = JSON.parse(JSON.stringify(input))
  const domains = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com', 'claudemcpclient.com', 'clau.de', 'hcaptcha.com', 'hcaptcha.net', 'challenges.cloudflare.com']
  const prefix = domains.map(host => `DOMAIN-SUFFIX,${host},REJECT`)
    .concat(['Claude', 'Claude Helper', 'Claude Helper (Renderer)', 'Claude Helper (GPU)', 'Claude Helper (Plugin)', 'claude', 'claude-code'].map(name => `PROCESS-NAME,${name},REJECT`))
    .concat('PROCESS-PATH-REGEX,.*(/\\.local/share/claude/versions/|/Claude\\.app/Contents/).*,REJECT')
  config.mode = 'rule'
  config.rules = prefix.concat((config.rules || []).filter(rule => !prefix.includes(rule)))
  return config
}
