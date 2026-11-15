export interface GuardStatus {
  state: 'observe' | 'protected' | 'blocked'
  reason: string
  enabled: boolean
  manual: boolean
  prepared: boolean
  expectedIP: string
  successes: number
  recoverySamples: number
  leaseMs: number
  intervalMs: number
  timeoutMs: number
  last: { ip: string, location: string, colo: string, sampledAt: number, verifiedAt: number, chains: string[] } | null
  gateway: { open: boolean, expiresAt: number, connections: number }
  events: { host: string, protocol: string, at: number }[]
  samples: { at: number, ok: boolean, reason: string, durationMs: number, ip?: string }[]
}

export interface GuardDiagnostics {
  checkedAt: number | null
  expiresAt: number
  state: string
  domains: { host: string, category: string, purpose: string, source: string | null, coverage: string, match: { index: number, type: string, policy: string } | null }[]
  dns: { state: string, leakTest?: string, ipv6Disabled?: boolean, enhancedMode?: string, rows: { host: string, configured: boolean, localPinned: boolean, servers: { host: string, transport: string, pinned: boolean }[] }[] } | null
  udp: { state: string, domainReject: boolean, gatewayTCPOnly: boolean } | null
  browser: { state: string, leakTest?: string, policy?: string, evidence?: string } | null
  observations: { state: string, rows: { host: string, network: string, reason: string }[], scope: string } | null
  routeCheck?: { checkedAt: number | null, state: string, rows: { host: string, checkedAt: number, durationMs: number, httpCode?: number, ip: string | null, state: string, route: { state: string, guarded: boolean, chains?: string[] } }[] }
}

