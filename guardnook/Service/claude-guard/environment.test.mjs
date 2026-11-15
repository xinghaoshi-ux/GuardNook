import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeEnvironment, CLIENT_CHECK_MAX_AGE } from '../../TestSupport/claudeEnvironment.ts'
const now = 1000000
function fixture() {
  const status = { state: 'protected', enabled: true, prepared: true, gateway: { open: true, expiresAt: now + 20000 }, last: { ip: '<IP>' } }
  const diagnostics = { checkedAt: now - 100, expiresAt: now + 100000, dns: { state: 'configured', leakTest: 'not-tested' }, udp: { state: 'configured' },
    browser: { state: 'configured', leakTest: 'not-tested' }, observations: { state: 'no-observed-bypass' },
    routeCheck: { rows: ['claude.ai', 'api.anthropic.com'].map(host => ({ host, checkedAt: now - 50, state: 'verified', ip: '<IP>', route: { guarded: true } })) } }
  return { status, diagnostics }
}
test('connection readiness requires fresh guard and both actual client routes; browser configuration is not a leak result', () => {
  const f = fixture(), result = claudeEnvironment(f.status, f.diagnostics, now, now - 1, false)
  assert.equal(result.state, 'ready'); assert.equal(result.browserVerified, false)
  f.diagnostics.routeCheck.rows[0].checkedAt = now - CLIENT_CHECK_MAX_AGE
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false).state, 'unknown')
})
test('a response between display-clock ticks stays current, but a far-future timestamp is not accepted', () => {
  const f = fixture()
  f.diagnostics.checkedAt = now + 200
  f.diagnostics.routeCheck.rows.forEach(row => row.checkedAt = now + 200)
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now + 250, false).state, 'ready')
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now + 10000, false).state, 'unknown')
})
test('expired guard, wrong exit and disconnected dashboard never imply readiness', () => {
  const f = fixture()
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 6000, false).state, 'unknown')
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, true).state, 'unknown')
  f.status.gateway.expiresAt = now
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false).state, 'blocked')
  f.status.gateway.expiresAt = now + 1000; f.status.last.ip = '<IP>'
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false).state, 'blocked')
})
test('stale or failed environment audit, bypass and client mismatch produce conservative advice only', () => {
  const f = fixture()
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false, true).state, 'unknown')
  f.diagnostics.expiresAt = now
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false).state, 'unknown')
  f.diagnostics.expiresAt = now + 100000; f.diagnostics.observations.state = 'needs-review'
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false).state, 'review')
  f.diagnostics.observations.state = 'no-observed-bypass'; f.diagnostics.routeCheck.rows[0].state = 'mismatch'
  assert.equal(claudeEnvironment(f.status, f.diagnostics, now, now - 1, false).state, 'review')
  assert.equal(f.status.gateway.open, true)
})
