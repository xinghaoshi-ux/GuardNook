import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { initialBoard, rollover } from './board.mjs'

export async function atomicJSON(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error('本机数据无法读取，原文件已保留。请在设置中打开数据目录检查。')
  }
}
export async function openStorage(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('数据目录必须为真实文件夹')
  const path = join(directory, 'board.json')
  let board = await readJSON(path, initialBoard())
  if (board.version !== 1 || !Array.isArray(board.todos) || !Array.isArray(board.folders) || typeof board.note !== 'string') throw new Error('本机数据格式无效，原文件已保留')
  board = { ...initialBoard(), ...board, todos: rollover(board.todos) }
  await atomicJSON(path, board)
  return { get: () => structuredClone(board), async set(value) { await atomicJSON(path, value); board = value } }
}
