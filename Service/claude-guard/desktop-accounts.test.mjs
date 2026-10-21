import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAccountManager, nextAccountName } from './desktop-accounts.mjs'
import { atomicJSON, desktopRoot } from './desktop-common.mjs'

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'guardnook-accounts-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const live = join(home, 'Library/Application Support/Claude')
  await mkdir(live, { recursive: true }); await writeFile(join(live, 'session'), 'alice')
  const dependencies = { home, authorize: async () => {}, quit: async () => {}, launch: async () => {},
    checkStopped: async () => {}, copy: (source, target) => cp(source, target, { recursive: true }), ...options }
  return { home, live, root: join(desktopRoot(home), 'accounts'), manager: createAccountManager(dependencies), dependencies }
}
const session = live => readFile(join(live, 'session'), 'utf8')

test('A/B/C/D use separate snapshots; switching restores the most recent session', async t => {
  const f = await fixture(t)
  await f.manager.adopt('A'); await f.manager.create(); await f.manager.create(); await f.manager.create()
  let state = await f.manager.list()
  assert.deepEqual(state.accounts.map(x => x.name), ['A', 'B', 'C', 'D'])
  const [a, b] = state.accounts
  await f.manager.switchTo(b.id)
  assert.deepEqual(await readdir(f.live), [])
  await writeFile(join(f.live, 'session'), 'bob')
  await f.manager.switchTo(a.id); assert.equal(await session(f.live), 'alice')
  await f.manager.switchTo(b.id); assert.equal(await session(f.live), 'bob')
  assert.equal((await f.manager.list()).currentID, b.id)
})

test('first switch automatically saves an unmanaged live login before replacement', async t => {
  const f = await fixture(t)
  await f.manager.create('B')
  const target = (await f.manager.list()).accounts[0]
  await f.manager.switchTo(target.id)
  const saved = (await f.manager.list()).accounts.find(x => x.id !== target.id)
  assert.equal(saved.name, 'A')
  assert.equal(await session(join(f.root, 'snapshots', saved.id)), 'alice')
})

test('a blocked guard prevents all live-data exchange', async t => {
  const f = await fixture(t, { authorize: async () => { throw new Error('blocked') } })
  await f.manager.create('B')
  await assert.rejects(f.manager.switchTo((await f.manager.list()).accounts[0].id), /blocked/)
  assert.equal(await session(f.live), 'alice')
  assert.equal((await f.manager.list()).currentID, null)
})

test('guard loss after directory exchange rolls back data and metadata', async t => {
  let calls = 0, reject = false
  const f = await fixture(t, { authorize: async () => { if (reject && ++calls === 3) throw new Error('lease expired') } })
  await f.manager.adopt('A'); await f.manager.create('B')
  const before = await f.manager.list(), target = before.accounts[1]
  reject = true
  await assert.rejects(f.manager.switchTo(target.id), /lease expired/)
  assert.equal(await session(f.live), 'alice')
  assert.equal((await f.manager.list()).currentID, before.currentID)
  assert.equal((await f.manager.list()).recoveryRequired, false)
})

test('metadata write failure after exchange restores the original session', async t => {
  let failID, failed = false
  const f = await fixture(t, { writeJSON: async (file, value) => {
    if (file.endsWith('index.json') && value.currentID === failID && !failed) { failed = true; throw new Error('disk error') }
    return atomicJSON(file, value)
  } })
  await f.manager.adopt('A'); await f.manager.create('B')
  failID = (await f.manager.list()).accounts[1].id
  await assert.rejects(f.manager.switchTo(failID), /disk error/)
  assert.equal(await session(f.live), 'alice')
  const restored = await f.manager.list()
  assert.equal(restored.accounts.find(x => x.id === restored.currentID)?.name, 'A')
})

test('copy failure leaves live data intact and removes partial target staging', async t => {
  let fail = false
  const f = await fixture(t, { copy: async (source, target) => {
    if (fail && target.includes('.guardnook-prepared-')) {
      await mkdir(target); await writeFile(join(target, 'partial'), 'partial'); throw new Error('no space')
    }
    await cp(source, target, { recursive: true })
  } })
  await f.manager.adopt('A'); await f.manager.create('B')
  const [a, b] = (await f.manager.list()).accounts
  await f.manager.switchTo(b.id); await writeFile(join(f.live, 'session'), 'bob'); await f.manager.switchTo(a.id)
  fail = true
  await assert.rejects(f.manager.switchTo(b.id), /no space/)
  assert.equal(await session(f.live), 'alice')
  assert.equal((await readdir(join(f.home, 'Library/Application Support'))).some(x => x.includes('.guardnook-prepared-')), false)
})

test('Claude reopening during snapshot preparation aborts before replacement', async t => {
  const f = await fixture(t, { checkStopped: async () => { throw new Error('reopened') } })
  await f.manager.adopt('A'); await f.manager.create('B')
  await assert.rejects(f.manager.switchTo((await f.manager.list()).accounts[1].id), /reopened/)
  assert.equal(await session(f.live), 'alice')
})

test('a crash journal can restore old data while preserving the interrupted new data', async t => {
  const f = await fixture(t)
  await f.manager.adopt('A'); await f.manager.create('B')
  const value = await f.manager.list(), previousIndex = { version: 1, currentID: value.currentID, accounts: value.accounts }
  const transaction = randomUUID()
  await rename(f.live, f.live + '.guardnook-previous-' + transaction)
  await mkdir(f.live); await writeFile(join(f.live, 'session'), 'new-login')
  await atomicJSON(join(f.root, 'transaction.json'), { transaction, phase: 'pending', hadLive: true, previousIndex })
  assert.equal((await f.manager.list()).recoveryRequired, true)
  await assert.rejects(f.manager.create('C'), /恢复/)
  await f.manager.recover()
  assert.equal(await session(f.live), 'alice')
  assert.equal(await session(join(f.root, 'recovered', transaction)), 'new-login')
  assert.equal((await f.manager.list()).recoveryRequired, false)
})

test('import copies legacy snapshots, never changes their source or adopts them as live', async t => {
  const f = await fixture(t), legacy = join(f.home, '.claude-switcher/accounts/A')
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'session'), 'old-alice')
  await f.manager.importLegacy()
  const value = await f.manager.list()
  assert.equal(value.currentID, null); assert.equal(value.accounts.length, 1)
  assert.equal(await session(legacy), 'old-alice'); assert.equal(await session(f.live), 'alice')
  assert.deepEqual(value.legacyAvailable, [])
})

test('a missing crash backup cannot silently relabel or delete the current data', async t => {
  const f = await fixture(t)
  await f.manager.adopt('A')
  const value = await f.manager.list()
  await atomicJSON(join(f.root, 'transaction.json'), { transaction: randomUUID(), phase: 'pending', hadLive: true,
    previousIndex: { version: 1, currentID: value.currentID, accounts: value.accounts } })
  await assert.rejects(f.manager.recover(), /备份不完整/)
  assert.equal(await session(f.live), 'alice')
  assert.equal((await f.manager.list()).recoveryRequired, true)
})

test('live-operation lock, invalid IDs and symlink indexes fail closed', async t => {
  const f = await fixture(t)
  await f.manager.list()
  await atomicJSON(join(f.root, 'operation.lock'), { pid: process.pid })
  await assert.rejects(f.manager.create('B'), /另一个账号操作/)
  await rm(join(f.root, 'operation.lock'))
  await assert.rejects(f.manager.switchTo('../../other'), /未找到/)
  await symlink(join(f.home, 'other.json'), join(f.root, 'index.json'))
  await assert.rejects(f.manager.list(), /普通文件/)
  assert.equal(await session(f.live), 'alice')
})

test('generated names extend beyond Z', () => {
  assert.equal(nextAccountName(Array.from({ length: 26 }, (_, index) => ({ name: String.fromCharCode(65 + index) }))), 'AA')
})
