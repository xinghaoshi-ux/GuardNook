import { isIP } from 'node:net'

const text = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 4096) : null
const port = value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null

// Each row belongs to a controller connection ID, never just a matching host.
// The private probe hop is excluded: its process is the forwarding proxy.
export function connectionRows(snapshot, c, observedAt = Date.now()) {
  if (!Array.isArray(snapshot?.connections)) throw new Error('Connection snapshot unavailable')
  return snapshot.connections.flatMap(connection => {
    const m = connection.metadata || {}, id = text(connection.id)
    if (!id || !connection.chains?.includes(c.gatewayProxy) || Number(m.inboundPort) === c.probePort) return []
    const started = Date.parse(connection.start)
    const sourceIP = isIP(m.sourceIP || '') ? m.sourceIP : null
    return [{ id, host: text(m.host) || text(m.sniffHost) || text(m.destinationIP),
      protocol: text(m.type), network: text(m.network),
      at: Number.isFinite(started) ? started : observedAt,
      timeSource: Number.isFinite(started) ? 'connection-start' : 'first-observed',
      process: text(m.process), processPath: text(m.processPath),
      sourceIP, sourcePort: port(m.sourcePort), active: true }]
  })
}

export function createConnectionLog(c, controller, { intervalMs = 1000 } = {}) {
  let events = [], checkedAt = null, available = false, pending, timer, stopped = false
  const status = () => ({ events: events.map(row => ({ ...row })), checkedAt, available })
  const inspect = () => {
    if (stopped) return Promise.resolve(status())
    if (pending) return pending
    pending = (async () => {
      try {
        const snapshot = await controller.request('/connections')
        if (stopped) return status()
        const observedAt = Date.now()
        const rows = connectionRows(snapshot, c, observedAt)
        const previous = new Map(events.map(row => [row.id, { ...row, active: false }]))
        for (const row of rows) {
          const old = previous.get(row.id)
          const same = old && old.host === row.host && old.sourceIP === row.sourceIP && old.sourcePort === row.sourcePort
            && (row.timeSource === 'first-observed' || old.at === row.at)
          previous.set(row.id, same ? { ...row, at: old.at, timeSource: old.timeSource,
            process: row.process || old.process, processPath: row.processPath || old.processPath } : row)
        }
        events = [...previous.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 40)
        checkedAt = observedAt; available = true
      } catch { available = false }
      return status()
    })().finally(() => { pending = undefined })
    return pending
  }
  return { status, inspect,
    start() { if (!timer && !stopped) { void inspect(); timer = setInterval(() => void inspect(), intervalMs) } },
    async stop() { stopped = true; clearInterval(timer); if (pending) await pending },
  }
}
