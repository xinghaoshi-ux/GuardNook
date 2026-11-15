'use strict'
const api = window.guardnook
const $ = id => document.getElementById(id)
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el }
let state, settings, apps = [], tab = 'home', folder = null, nodes = [], noteTimer, toastTimer, appsLoaded = false, noteRevision = 0
const today = date => { const d = date || new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
let selectedDay = today(), observedDay = today()
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true }, 6000) }
async function call(name, input) {
  const result = await api[name](input)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
async function busy(button, operation) {
  button.disabled = true
  try { return await operation() } catch (error) { toast(error.message) }
  finally { button.disabled = false }
}
function on(id, event, handler) {
  $(id).addEventListener(event, async event => { try { await handler(event) } catch (error) { toast(error.message) } })
}
async function board(action) { state.board = await call('board', action); renderBoard(); return state.board }
function switchTab(name) {
  tab = name
  document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== name })
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === name || name === 'setup' && el.dataset.tab === 'guard'))
  document.querySelector('main').scrollTop = 0
  if (name === 'apps' && !appsLoaded) loadApps(true)
  if (name === 'setup') fillSetup()
}
function protection() {
  const s = state.status, now = Date.now()
  return s.state === 'protected' && s.enabled === true && s.prepared === true && s.last?.ip === settings?.expectedIP
    && s.gateway?.open === true && s.gateway.expiresAt > now && now - s.receivedAt < 5000
}
const reasons = {
  'observation-only': '当前仅观测，尚未启用保护。', 'guard-route-not-installed': '未确认守护规则，请在 Clash 导入生成的脚本并重载配置。',
  'protected-rules-changed': 'Claude 分流规则已改变，网关保持阻断。', 'coverage-rules-changed': '保护覆盖规则已改变，网关保持阻断。',
  'frozen-chain-changed': '固定节点链已改变，请重新确认节点配置。', 'rule-mode-required': '请把 Clash 切换到“规则”模式。',
  'tun-required': 'TUN 未开启，网关保持阻断。请在 Clash 开启 TUN。', 'tun-status-unavailable': '无法确认 TUN 状态，网关保持阻断。',
  'probe-or-controller-unavailable': '探测或 Clash 控制接口不可用，网关保持阻断。', 'manual-block': '已手动阻断。需点击“启用保护”后重新验证。',
  'confirming-exit': '正在连续确认固定出口，验证完成前保持阻断。', 'exit-ip-mismatch': '实测出口与允许的 IPv4 不一致。',
  'verified-pinned-exit': '固定节点、分流规则与出口已连续验证；仅当前有效租约内放行。',
  'verification-expired': '验证已过期，网关保持阻断。', 'ready-not-enabled': '规则与出口已检查，尚未启用保护。',
}
function renderState() {
  const expanded = state.expanded
  $('pill').hidden = expanded; $('panel').hidden = !expanded
  document.body.classList.toggle('light', !state.dark)
  const now = new Date(), time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  $('clock').textContent = time; $('pill-clock').textContent = time
  $('beijing').hidden = !state.board.beijingClock
  $('beijing').textContent = '北京 ' + now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
  $('today-label').textContent = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  $('pin').textContent = state.board.pinned ? '◆' : '◇'; $('pin').setAttribute('aria-pressed', String(state.board.pinned))
  const good = protection(), configured = !!settings, s = state.status
  $('pill-dot').className = `status-dot ${good ? 'good' : configured ? 'bad' : ''}`
  $('nav-status').textContent = good ? '固定出口已放行' : configured ? s.enabled ? '保护已阻断' : '尚未启用保护' : '未配置保护'
  $('guard-title').textContent = good ? '固定出口已放行' : !configured ? '尚未配置保护' : s.state === 'unconfigured' ? '守护未启动' : s.enabled ? '保护已阻断' : '尚未启用保护'
  $('guard-reason').textContent = reasons[!good && s.state === 'protected' ? 'verification-expired' : s.reason] || s.reason || '先选择 Clash 中的固定节点和允许的出口 IPv4。'
  $('guard-tag').textContent = good ? '已验证' : configured ? '未放行' : '未接入'
  $('expected-ip').textContent = settings?.expectedIP || '—'
  $('observed-ip').textContent = s.last?.verifiedAt && Date.now() - s.last.verifiedAt < 45000 ? s.last.ip || '未知' : '未知 / 已过期'
  $('samples').textContent = configured ? `${s.successes || 0} / ${s.recoverySamples || 3}` : '—'
  $('connections').textContent = String(s.gateway?.connections || 0)
  for (const id of ['guard-enable', 'guard-block', 'guard-inspect', 'guard-audit', 'guard-route']) $(id).disabled = !configured
  renderConnections(); renderNetworks()
  const day = today()
  if (day !== observedDay) {
    if (selectedDay === observedDay) selectedDay = day
    observedDay = day; $('todo-date').value = selectedDay
    void board({ type: 'preferences' }).catch(error => toast(error.message))
  }
}
function renderBoard() {
  if (!state) return
  if (document.activeElement !== $('note')) $('note').value = state.board.note
  $('note-count').textContent = `${$('note').value.length} 字`
  $('pinned').checked = state.board.pinned; $('beijing-clock').checked = state.board.beijingClock
  $('theme').value = state.board.theme; $('display').value = state.board.displayId === null ? '' : String(state.board.displayId)
  renderTodos(); if (tab === 'apps') renderApps()
}
function renderTodos() {
  $('days').replaceChildren()
  const center = new Date(selectedDay + 'T12:00:00')
  for (let offset = -3; offset <= 3; offset++) {
    const d = new Date(center); d.setDate(d.getDate() + offset)
    const key = today(d), b = node('button', undefined, `day${key === selectedDay ? ' active' : ''}`)
    b.type = 'button'; b.setAttribute('aria-label', key)
    b.append(node('small', d.toLocaleDateString('zh-CN', { weekday: 'short' })), node('span', String(d.getDate())))
    b.addEventListener('click', () => { selectedDay = key; $('todo-date').value = key; renderTodos() })
    $('days').append(b)
  }
  const list = $('todo-list'); list.replaceChildren()
  const items = state.board.todos.filter(item => item.day === selectedDay)
  if (!items.length) list.append(node('p', '这一天，还没有待办。', 'empty'))
  for (const item of items) {
    const row = node('div', undefined, 'todo-row' + (item.done ? ' done' : ''))
    const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = item.done
    checkbox.addEventListener('change', () => board({ type: 'toggleTodo', id: item.id }).catch(error => toast(error.message)))
    const remove = node('button', '×', 'icon-button'); remove.setAttribute('aria-label', `删除待办：${item.text}`)
    remove.addEventListener('click', () => board({ type: 'deleteTodo', id: item.id }).catch(error => toast(error.message)))
    label.append(checkbox, node('span', item.text, 'todo-text')); row.append(label, remove); list.append(row)
  }
}
function renderNetworks() {
  const cards = $('network-cards'); cards.replaceChildren()
  for (const [key, name] of [['claude', 'Claude'], ['codex', 'Codex'], ['ipv4', 'IPv4'], ['cloudflare', 'Cloudflare']]) {
    const p = state.probes[key], fresh = p && Date.now() - p.at < 120000
    const card = node('article', undefined, 'network-card'), heading = node('div', undefined, 'network-label')
    heading.append(node('span', name), node('span', undefined, `status-dot ${fresh ? p.ok ? 'good' : 'bad' : ''}`))
    card.append(heading, node('p', fresh && p.ok ? p.ip : fresh ? '检测失败' : '尚未检测', 'network-ip'), node('p', fresh ? p.ok ? `${p.location || ''} ${p.source}`.trim() : p.reason : p ? '结果已过期，请重新检测' : '点击“重新检测”开始', 'network-detail'))
    cards.append(card)
  }
}
function renderConnections() {
  const log = state.status.connectionLog, list = $('connection-list')
  list.replaceChildren()
  const fresh = log?.available === true && Date.now() - log.checkedAt < 5000
  $('log-state').textContent = fresh ? '来自 Clash 内核 · 当前可见连接' : '记录不可用或已过期'
  const rows = log?.events || []
  if (!rows.length) list.append(node('p', '暂无 Claude 连接记录。', 'empty'))
  for (const item of rows.slice(0, 25)) {
    const row = node('div', undefined, 'connection-row')
    row.title = [item.host, item.process, item.processPath, item.sourceIP, item.sourcePort].filter(Boolean).join('\n')
    row.append(node('time', new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })), node('span', item.host || '未提供主机名'), node('span', item.process || '进程未知', 'muted'))
    list.append(row)
  }
}
async function loadApps(refresh = false) {
  $('app-message').textContent = '正在读取应用…'
  try { apps = await call('apps', { refresh }); appsLoaded = true; renderApps() }
  catch (error) { $('app-message').textContent = error.message }
}
async function textDialog(title, value = '') {
  const dialog = $('text-dialog'); $('dialog-title').textContent = title; $('dialog-input').value = value; dialog.returnValue = ''
  dialog.showModal(); $('dialog-input').focus()
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }))
  return dialog.returnValue === 'ok' ? $('dialog-input').value.trim() : null
}
async function moveDialog(app) {
  $('move-title').textContent = `归类：${app.name}`
  const select = $('move-folder'); select.replaceChildren(new Option('全部应用（移出文件夹）', ''))
  for (const f of state.board.folders) select.add(new Option(f.name, f.id))
  select.value = state.board.memberships[app.id] || ''
  const dialog = $('move-dialog'); dialog.returnValue = ''; dialog.showModal()
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }))
  if (dialog.returnValue === 'ok') await board({ type: 'moveApp', id: app.id, folder: select.value })
}
function renderApps() {
  const grid = $('app-grid'), query = $('app-search').value.trim().toLocaleLowerCase(), b = state.board
  grid.replaceChildren()
  const currentFolder = b.folders.find(f => f.id === folder)
  if (!currentFolder) folder = null
  $('folder-back').hidden = !folder; $('folder-heading').hidden = !folder
  $('folder-heading').querySelector('h2').textContent = currentFolder?.name || ''
  $('app-message').textContent = state.scanError || `${apps.length} 个应用${query ? ' · 搜索结果' : ''}`
  function tile({ id, name, icon, isFolder }) {
    const wrapper = node('div', undefined, 'app-tile'); wrapper.draggable = !isFolder
    const open = node('button', undefined, 'app-open')
    if (icon) { const image = node('img'); image.src = icon; image.alt = ''; open.append(image) }
    else open.append(node('span', isFolder ? '▤' : name[0], `app-letter ${isFolder ? 'folder-icon' : ''}`))
    open.append(node('span', name, 'app-name'))
    open.addEventListener('click', () => {
      if (isFolder) { folder = id; renderApps() }
      else call('launch', id).catch(error => toast(error.message))
    })
    wrapper.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move' })
    wrapper.addEventListener('dragover', event => { event.preventDefault(); wrapper.classList.add('drag-over') })
    wrapper.addEventListener('dragleave', () => wrapper.classList.remove('drag-over'))
    wrapper.addEventListener('drop', async event => {
      event.preventDefault(); wrapper.classList.remove('drag-over')
      const dragged = event.dataTransfer.getData('text/plain')
      if (dragged === id || !apps.some(a => a.id === dragged)) return
      try {
        if (isFolder) await board({ type: 'moveApp', id: dragged, folder: id })
        else if ($('app-sort').value === 'custom') {
          const ids = sorted.map(a => a.id).filter(value => value !== dragged)
          ids.splice(ids.indexOf(id), 0, dragged); await board({ type: 'order', ids })
        } else {
          const result = await board({ type: 'folder', name: '新建文件夹' }), newId = result.folders.at(-1).id
          await board({ type: 'moveApp', id: dragged, folder: newId }); await board({ type: 'moveApp', id, folder: newId })
        }
      } catch (error) { toast(error.message) }
    })
    wrapper.append(open)
    if (!isFolder) {
      const menu = node('button', '⋯', 'app-menu'); menu.setAttribute('aria-label', `管理 ${name}`)
      menu.addEventListener('click', () => moveDialog({ id, name }).catch(error => toast(error.message)))
      wrapper.append(menu)
    }
    grid.append(wrapper)
  }
  const sorted = [...apps].sort((a, c) => {
    if ($('app-sort').value === 'custom') {
      const ai = b.order.indexOf(a.id), ci = b.order.indexOf(c.id)
      if (ai !== ci) return (ai < 0 ? 100000 : ai) - (ci < 0 ? 100000 : ci)
    }
    return a.name.localeCompare(c.name, 'zh-Hans-CN')
  })
  if (!folder && !query) for (const f of b.folders) tile({ ...f, isFolder: true })
  for (const a of sorted) {
    if (query ? !a.name.toLocaleLowerCase().includes(query) : folder ? b.memberships[a.id] !== folder : b.memberships[a.id] && b.folders.some(f => f.id === b.memberships[a.id])) continue
    tile(a)
  }
  if (!grid.children.length) grid.append(node('p', query ? '没有找到匹配的应用。' : '这里还没有应用。', 'empty'))
}
function setupInput() {
  return { controllerURL: $('controller-url').value.trim(), controllerSecret: $('controller-secret').value,
    selectedProxy: $('selected-proxy').value, expectedIP: $('expected-input').value.trim(), serverPort: Number($('server-port').value), clientPort: Number($('client-port').value),
    probePort: Number($('probe-port').value), gatewayPort: Number($('gateway-port').value), requireTun: $('require-tun').checked, startProtected: $('start-protected').checked }
}
function fillSetup() {
  if (!settings) return
  $('controller-url').value = settings.controllerURL || 'http://127.0.0.1:9090'
  $('controller-secret').value = ''; $('secret-hint').textContent = settings.hasSecret ? '已保存密钥，留空保留；填写可替换。' : '未设置密钥可留空。'
  $('expected-input').value = settings.expectedIP || ''
  for (const [id, key] of [['server-port', 'serverPort'], ['client-port', 'clientPort'], ['probe-port', 'probePort'], ['gateway-port', 'gatewayPort']]) $(id).value = settings[key]
  $('require-tun').checked = settings.requireTun !== false; $('start-protected').checked = !!settings.startProtected
  if (!nodes.length) { $('selected-proxy').replaceChildren(new Option(settings.selectedProxy, settings.selectedProxy)); $('selected-proxy').value = settings.selectedProxy }
}
function showDiagnostics(result, route = false) {
  const box = $('diagnostics'); box.replaceChildren(); box.hidden = false
  if (route) {
    for (const row of result.rows || []) box.append(node('p', `${row.host}：${row.state === 'verified' ? '客户端路径已验证' : '尚未验证 / 不符合'}${row.ip ? ` · ${row.ip}` : ''}`))
  } else {
    box.append(node('p', `域名规则：${result.domains?.filter(row => row.coverage === 'covered').length || 0} 项有覆盖证据；其他项需检查。`), node('p', 'DNS / 浏览器泄漏：未实测，保持未知。'), node('p', `可见旁路连接：${result.observations?.rows?.length ?? '未知'}。没有发现异常不代表不存在旁路。`))
  }
}
async function init() {
  const boot = await call('boot'); state = boot; settings = boot.settings
  $('version').textContent = 'v' + boot.version; $('login').checked = boot.login
  $('display').add(new Option('主显示器', ''))
  for (const display of boot.displays) $('display').add(new Option(display.label, String(display.id)))
  $('todo-date').value = selectedDay; renderState(); renderBoard()
  if (!settings) switchTab('setup')
  window.guardnookEvents.onState(next => { state = { ...state, ...next }; renderState(); renderBoard() })
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)))
  on('pill', 'click', () => call('window', 'expand')); on('collapse', 'click', () => call('window', 'collapse'))
  on('pin', 'click', () => board({ type: 'preferences', pinned: !state.board.pinned }))
  on('todo-date', 'change', () => { if ($('todo-date').value) { selectedDay = $('todo-date').value; renderTodos() } })
  on('todo-form', 'submit', async event => { event.preventDefault(); await board({ type: 'addTodo', text: $('todo-draft').value, day: selectedDay }); $('todo-draft').value = '' })
  on('note', 'input', () => {
    const revision = ++noteRevision, text = $('note').value
    $('note-count').textContent = `${text.length} 字`; $('note-state').textContent = '正在保存…'; clearTimeout(noteTimer)
    noteTimer = setTimeout(async () => {
      try { await board({ type: 'note', text }); if (noteRevision === revision) $('note-state').textContent = '已保存到本机' }
      catch (error) { $('note-state').textContent = '保存失败，请重试'; toast(error.message) }
    }, 350)
  })
  on('note', 'blur', async () => {
    if ($('note').value !== state.board.note) {
      clearTimeout(noteTimer)
      await board({ type: 'note', text: $('note').value })
      $('note-state').textContent = '已保存到本机'
    }
  })
  on('probe-refresh', 'click', () => busy($('probe-refresh'), async () => { state.probes = await call('probes'); renderNetworks() }))
  on('apps-refresh', 'click', () => busy($('apps-refresh'), () => loadApps(true)))
  on('app-search', 'input', renderApps); on('app-sort', 'change', renderApps)
  on('folder-back', 'click', () => { folder = null; renderApps() })
  on('add-folder', 'click', async () => { const name = await textDialog('新建文件夹'); if (name) await board({ type: 'folder', name }) })
  on('rename-folder', 'click', async () => { const f = state.board.folders.find(f => f.id === folder); const name = await textDialog('重命名文件夹', f.name); if (name) await board({ type: 'folder', id: folder, name }) })
  on('delete-folder', 'click', () => board({ type: 'deleteFolder', id: folder }))
  on('add-app', 'click', async () => { const result = await call('addApp'); if (result) { apps = result; renderApps() } })
  on('configure', 'click', () => switchTab('setup')); on('setup-back', 'click', () => switchTab('guard'))
  on('load-nodes', 'click', () => busy($('load-nodes'), async () => {
    const previous = $('selected-proxy').value, result = await call('catalogue', setupInput()); nodes = result.nodes
    $('selected-proxy').replaceChildren(new Option('请选择具体节点', ''))
    for (const n of nodes) { const option = new Option(n.name + (n.chainError ? '（链路不可用）' : ''), n.name); option.disabled = !!n.chainError; $('selected-proxy').add(option) }
    $('selected-proxy').value = previous; $('node-count').textContent = `${nodes.length} 个具体节点 · Mihomo ${result.version}`
  }))
  on('selected-proxy', 'change', () => { const selected = nodes.find(n => n.name === $('selected-proxy').value); $('chain-hint').textContent = selected?.chainError || (selected?.upstreamChain?.length ? '上游固定链：' + selected.upstreamChain.join(' → ') : '已选择具体节点。保存时会再次确认链路。') })
  on('pick-script', 'click', async () => { $('script-name').textContent = await call('pickScript') || '没有原脚本时使用透传脚本' })
  on('setup-form', 'submit', async event => {
    event.preventDefault()
    await busy($('save-setup'), async () => {
      const result = await call('saveSetup', setupInput()); settings = result.settings
      $('setup-result').textContent = '配置已保存，尚未完成 Clash 接入。请点击“显示生成的脚本”，在 Clash 全局扩展脚本导入它，重载配置并开启 TUN，然后返回守护页启用保护。'
      toast('配置已保存。下一步：将生成脚本导入 Clash。'); renderState()
    })
  })
  on('reveal-script', 'click', () => call('revealScript'))
  for (const [id, action] of [['guard-enable', 'enable'], ['guard-block', 'block'], ['guard-inspect', 'inspect'], ['guard-audit', 'audit'], ['guard-route', 'route-check']]) {
    on(id, 'click', () => busy($(id), async () => { const result = await call('guard', action); if (action === 'audit' || action === 'route-check') showDiagnostics(result, action === 'route-check') }))
  }
  on('login', 'change', async () => { try { $('login').checked = await call('login', $('login').checked) } catch (error) { $('login').checked = !$('login').checked; throw error } })
  on('pinned', 'change', () => board({ type: 'preferences', pinned: $('pinned').checked }))
  on('beijing-clock', 'change', () => board({ type: 'preferences', beijingClock: $('beijing-clock').checked }))
  on('theme', 'change', () => board({ type: 'preferences', theme: $('theme').value }))
  on('display', 'change', () => board({ type: 'preferences', displayId: $('display').value ? Number($('display').value) : null }))
  on('open-data', 'click', () => call('openData')); on('export-board', 'click', async () => { if (await call('exportData')) toast('待办与随手记已导出，不含节点和密钥。') })
  on('quit', 'click', async () => { clearTimeout(noteTimer); await board({ type: 'note', text: $('note').value }); await call('quit') })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) call('window', 'collapse').catch(() => {}) })
}
window.guardnookReady = init().catch(error => { toast(error.message); throw error })
