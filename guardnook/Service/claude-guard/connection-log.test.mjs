import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionRows, createConnectionLog } from './connection-log.mjs'
import { DEFAULT_CONFIG as c } from './config.mjs'

const connection = (id, process = '', sourcePort = '54001') => ({ id,
  start: '2026-10-12T15:00:00+09:00', chains: [c.gatewayProxy, c.policyGroup],
  metadata: { host: 'claude.ai', type: 'HTTPS', network: 'tcp', inboundPort: c.clientPort,
    sourceIP: '127.0.0.1', sourcePort, process, processPath: process ? `/Applications/${process}.app/Contents/MacOS/${process}` : '' } })

test('simultaneous connections to the same host retain their own process identities', () => {
  const rows = connectionRows({ connections: [connection('browser', 'Browser'), connection('cli', 'claude', '54002')] }, c)
  assert.deepEqual(rows.map(row => [row.id, row.process, row.sourcePort]), [['browser', 'Browser', 54001], ['cli', 'claude', 54002]])
  assert.equal(rows[0].at, Date.parse('2026-10-12T15:00:00+09:00'))
})

test('unknown processes stay absent; private forwarding probes and unrelated routes are excluded', () => {
  const privateProbe = connection('probe', 'node'); privateProbe.metadata.inboundPort = c.probePort
  const other = connection('direct', 'Browser'); other.chains = ['DIRECT']
  const rows = connectionRows({ connections: [connection('unknown'), privateProbe, other] }, c)
  assert.equal(rows.length, 1); assert.equal(rows[0].process, null); assert.equal(rows[0].processPath, null)
  assert.equal(rows[0].sourceIP, '127.0.0.1'); assert.equal(rows[0].sourcePort, 54001)
})

test('process metadata can arrive later and survives completion without being transferred to another connection', async () => {
  let snapshot = { connections: [connection('one')] }
  const log = createConnectionLog(c, { request: async () => snapshot })
  await log.inspect(); assert.equal(log.status().events[0].process, null)
  snapshot = { connections: [connection('one', 'Browser')] }
  await log.inspect(); assert.equal(log.status().events[0].process, 'Browser')
  snapshot = { connections: [] }; await log.inspect()
  assert.equal(log.status().events[0].active, false); assert.equal(log.status().events[0].process, 'Browser')
  snapshot = { connections: [connection('two', '', '54002')] }; await log.inspect()
  assert.equal(log.status().events.find(row => row.id === 'two').process, null)
  snapshot = { connections: [connection('one', '', '54999')] }; await log.inspect()
  assert.equal(log.status().events.find(row => row.id === 'one').process, null)
  await log.stop()
})

test('an unavailable controller marks the log unavailable and preserves historical evidence', async () => {
  let fail = false
  const log = createConnectionLog(c, { request: async () => { if (fail) throw new Error('offline'); return { connections: [connection('one', 'Browser')] } } })
  await log.inspect(); const checkedAt = log.status().checkedAt
  fail = true; await log.inspect()
  assert.equal(log.status().available, false); assert.equal(log.status().checkedAt, checkedAt)
  assert.equal(log.status().events[0].process, 'Browser')
  await log.stop()
})

test('polling serializes controller reads and caps the recent history', async () => {
  let release, calls = 0
  const promise = new Promise(resolve => release = resolve)
  const log = createConnectionLog(c, { request: () => { calls++; return promise } })
  const first = log.inspect(), second = log.inspect()
  assert.equal(calls, 1)
  release({ connections: Array.from({ length: 55 }, (_, i) => connection(`row-${i}`, 'Browser', String(54000 + i))) })
  await Promise.all([first, second]); assert.equal(log.status().events.length, 40)
  await log.stop()
})
