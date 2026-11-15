import test from 'node:test'
import assert from 'node:assert/strict'
import { validateBaseline, reachability, stunVerdict } from './desktop-environment.mjs'
import { protectedStatus } from './desktop-common.mjs'
import { parseBinding } from './desktop-stun.mjs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGuardConfig, atomicJSON } from './desktop-common.mjs'

test('environment policy validates fields before any command interpolation', () => {
  const value = { country: 'US', timezone: 'America/New_York', locale: 'en_US', language: 'en-US' }
  assert.deepEqual(validateBaseline(value), value)
  for (const key of Object.keys(value)) assert.throws(() => validateBaseline({ ...value, [key]: "'; touch /tmp/bad; '" }))
})
test('HTTP denial is distinguishable from connectivity and missing credentials', () => {
  assert.equal(reachability([403, 401]).state, 'warn')
  assert.match(reachability([200, 401]).detail, /未验证登录/)
  assert.equal(reachability([0, 401]).state, 'fail')
})
test('STUN silence never becomes a zero-leak success', () => {
  assert.equal(stunVerdict([], '<IP>').state, 'unknown')
  assert.equal(stunVerdict(['<IP>'], '<IP>').state, 'warn')
  assert.equal(stunVerdict(['<IP>'], null).state, 'unknown')
  assert.equal(stunVerdict(['<IP>'], '<IP>').state, 'ok')
})
test('protected status requires an unexpired matching exit, TUN and open gateway', () => {
  const config = { expectedIP: '<IP>', requireTun: true }
  const status = { state: 'protected', enabled: true, prepared: true, expectedIP: config.expectedIP,
    last: { ip: config.expectedIP }, tunEnabled: true, gateway: { open: true, expiresAt: 110 } }
  assert.equal(protectedStatus(status, config, 100), true)
  assert.equal(protectedStatus(status, config, 111), false)
  assert.equal(protectedStatus({ ...status, manual: true }, config, 100), false)
  assert.equal(protectedStatus({ ...status, tunEnabled: false }, config, 100), false)
  assert.equal(protectedStatus({ ...status, last: { ip: '<IP>' } }, config, 100), false)
})
test('STUN parser validates transaction and packet boundaries before returning address', () => {
  const transaction = Buffer.alloc(12, 7), packet = Buffer.alloc(32)
  packet.writeUInt16BE(0x101, 0); packet.writeUInt16BE(12, 2); packet.writeUInt32BE(0x2112a442, 4)
  transaction.copy(packet, 8); packet.writeUInt16BE(0x20, 20); packet.writeUInt16BE(8, 22); packet[25] = 1
  const expected = [203, 0, 113, 1], mask = [0x21, 0x12, 0xa4, 0x42]
  expected.forEach((value, i) => { packet[28 + i] = value ^ mask[i] })
  assert.equal(parseBinding(packet, transaction), '<IP>')
  assert.equal(parseBinding(packet, Buffer.alloc(12)), null)
  assert.equal(parseBinding(packet.subarray(0, 30), transaction), null)
})
test('legacy private credentials are reused only for the same configured guard identity', async t => {
  const home = await mkdtemp(join(tmpdir(), 'guardnook-identity-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'Library/Application Support')
  await mkdir(join(root, 'ClaudeGuard'), { recursive: true }); await mkdir(join(root, 'GuardNook'))
  const original = { expectedIP: '<IP>', proxyPassword: 'a'.repeat(64) }
  await atomicJSON(join(root, 'ClaudeGuard/config.json'), original)
  const portable = { ...original, serviceMode: 'existing', proxyPassword: '' }
  await atomicJSON(join(root, 'GuardNook/config.json'), portable)
  assert.equal((await readGuardConfig(home)).proxyPassword, original.proxyPassword)
  await atomicJSON(join(root, 'GuardNook/config.json'), { ...portable, expectedIP: '<IP>' })
  await assert.rejects(readGuardConfig(home), /身份不一致/)
})
