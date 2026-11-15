import { randomUUID } from 'node:crypto'

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false
  const [y, m, d] = day.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d)) === day
}
export function rollover(items, today = dayKey()) {
  return items.map(item => ({ ...item, day: !item.day || !item.done && validDay(item.day) && item.day < today ? today : item.day }))
}
export function initialBoard() {
  return { version: 1, todos: [], note: '', folders: [], memberships: {}, order: [], customApps: [], theme: 'dark', pinned: false, displayId: null, beijingClock: false }
}
export function updateBoard(board, action) {
  const next = structuredClone(board)
  next.todos = rollover(next.todos)
  switch (action.type) {
    case 'addTodo':
      if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 2000 || !validDay(action.day)) throw new Error('请输入有效的待办和日期')
      if (next.todos.length >= 10000) throw new Error('待办数量已达上限')
      next.todos.push({ id: randomUUID(), text: action.text.trim(), done: false, day: action.day }); break
    case 'toggleTodo': {
      const todo = next.todos.find(t => t.id === action.id)
      if (!todo) throw new Error('待办已不存在')
      todo.done = !todo.done; break
    }
    case 'deleteTodo': next.todos = next.todos.filter(t => t.id !== action.id); break
    case 'note':
      if (typeof action.text !== 'string' || action.text.length > 100000) throw new Error('随手记最多 100000 字')
      next.note = action.text; break
    case 'folder':
      if (typeof action.name !== 'string' || !action.name.trim() || action.name.length > 40) throw new Error('文件夹名称需为 1–40 字')
      if (next.folders.length >= 100) throw new Error('文件夹数量已达上限')
      if (action.id) {
        const folder = next.folders.find(f => f.id === action.id)
        if (!folder) throw new Error('文件夹已不存在')
        folder.name = action.name.trim()
      } else next.folders.push({ id: randomUUID(), name: action.name.trim() })
      break
    case 'deleteFolder':
      next.folders = next.folders.filter(f => f.id !== action.id)
      next.memberships = Object.fromEntries(Object.entries(next.memberships).filter(([, folder]) => folder !== action.id)); break
    case 'moveApp':
      if (typeof action.id !== 'string' || action.id.length > 4096 || action.folder && !next.folders.some(f => f.id === action.folder)) throw new Error('文件夹或应用无效')
      if (action.folder) next.memberships[action.id] = action.folder
      else delete next.memberships[action.id]
      break
    case 'order':
      if (!Array.isArray(action.ids) || action.ids.length > 10000 || action.ids.some(id => typeof id !== 'string' || id.length > 4096)) throw new Error('应用排序无效')
      next.order = [...new Set(action.ids)]; break
    case 'preferences':
      for (const key of ['pinned', 'beijingClock']) if (action[key] !== undefined) {
        if (typeof action[key] !== 'boolean') throw new Error('设置无效')
        next[key] = action[key]
      }
      if (action.theme !== undefined) {
        if (!['dark', 'light', 'system'].includes(action.theme)) throw new Error('主题无效')
        next.theme = action.theme
      }
      if (action.displayId !== undefined) {
        if (action.displayId !== null && !Number.isInteger(action.displayId)) throw new Error('显示器无效')
        next.displayId = action.displayId
      }
      break
    default: throw new Error('未知操作')
  }
  return next
}
