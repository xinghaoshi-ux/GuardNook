import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialBoard, updateBoard, rollover, validDay } from '../src/board.mjs'
import { openStorage } from '../src/storage.mjs'

test('unfinished past work rolls over; completed history and future work survive restarts', () => {
  const items = [{ id: 'a', day: '2026-10-01', done: false }, { id: 'b', day: '2026-10-01', done: true }, { id: 'c', day: '2026-11-01', done: false }, { id: 'd', done: false }]
  const result = rollover(items, '2026-10-17')
  assert.deepEqual(result.map(t => t.day), ['2026-10-17', '2026-10-01', '2026-11-01', '2026-10-17'])
  assert.deepEqual(rollover(result, '2026-10-17'), result)
  assert.equal(items[0].day, '2026-10-01')
  assert.equal(validDay('2026-02-30'), false)
  assert.equal(validDay('2028-02-29'), true)
})
test('folder changes preserve application identities and dissolving a folder returns its contents', () => {
  let board = updateBoard(initialBoard(), { type: 'folder', name: '工作' })
  const id = board.folders[0].id
  board = updateBoard(board, { type: 'moveApp', id: 'C:\\Tools\\A.exe', folder: id })
  board = updateBoard(board, { type: 'folder', id, name: '常用' })
  assert.equal(board.memberships['C:\\Tools\\A.exe'], id)
  board = updateBoard(board, { type: 'deleteFolder', id })
  assert.deepEqual(board.memberships, {})
  assert.throws(() => updateBoard(board, { type: 'moveApp', id: 'a', folder: 'missing' }))
})
test('notes, scheduled tasks, theme and sort order persist across reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardnook-board-'))
  try {
    const store = await openStorage(dir)
    let board = updateBoard(store.get(), { type: 'note', text: '中文笔记\n<script>literal text</script>' })
    board = updateBoard(board, { type: 'addTodo', text: '未来工作', day: '2099-10-17' })
    board = updateBoard(board, { type: 'preferences', theme: 'light', pinned: true })
    board = updateBoard(board, { type: 'order', ids: ['a', 'b', 'a'] })
    await store.set(board)
    assert.deepEqual((await openStorage(dir)).get(), board)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('unreadable existing data is preserved instead of reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardnook-corrupt-'))
  try {
    await writeFile(join(dir, 'board.json'), '{broken')
    await assert.rejects(openStorage(dir), /原文件已保留/)
    assert.equal(await readFile(join(dir, 'board.json'), 'utf8'), '{broken')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('invalid dates and oversized content cannot enter persisted board state', () => {
  assert.throws(() => updateBoard(initialBoard(), { type: 'addTodo', text: 'x', day: '2026-02-30' }))
  assert.throws(() => updateBoard(initialBoard(), { type: 'note', text: 'x'.repeat(100001) }))
  assert.throws(() => updateBoard(initialBoard(), { type: 'preferences', theme: 'injected' }))
})
