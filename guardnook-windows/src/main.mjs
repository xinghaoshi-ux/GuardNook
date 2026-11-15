import { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, nativeImage, shell, dialog, net, nativeTheme } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isIP } from 'node:net'
import { openStorage, atomicJSON, readJSON } from './storage.mjs'
import { updateBoard } from './board.mjs'
import { scanApps, normalizeApps } from './launcher.mjs'
import { createRuntime } from './runtime.mjs'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const uiPath = join(here, '../renderer/index.html')
const uiURL = pathToFileURL(uiPath).href
const smoke = !app.isPackaged && process.argv.includes('--smoke-test')
app.setName('GuardNook')
if (!app.isPackaged && process.env.GUARDNOOK_TEST_DATA) app.setPath('userData', process.env.GUARDNOOK_TEST_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let window, tray, store, runtime, timer, hoverTimer, board, quitting = false, expanded = false, catalogue = [], scanPending, mutation = Promise.resolve(), originalScript, scriptName = '', probePending
  let probes = {}, scanError = null, hoverSince = 0
  const directory = app.getPath('userData')
  const serviceDirectory = app.isPackaged ? join(process.resourcesPath, 'Service/claude-guard') : join(here, '../../guardnook/Service/claude-guard')
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'AppIcon.png') : join(here, '../../guardnook/Assets/AppIcon.png')
  const enqueue = operation => {
    const result = mutation.then(operation)
    mutation = result.catch(() => {})
    return result
  }
  const applyTheme = () => { nativeTheme.themeSource = board.theme }
  const snapshot = () => ({ board: store.get(), status: runtime.status(), probes, expanded, dark: nativeTheme.shouldUseDarkColors, scanError })
  const push = () => { if (window && !window.isDestroyed()) window.webContents.send('guardnook:state', snapshot()) }
  function position() {
    const display = screen.getAllDisplays().find(d => d.id === board.displayId) || screen.getPrimaryDisplay()
    const area = display.workArea
    const width = expanded ? Math.min(960, area.width - 24) : 228
    const height = expanded ? Math.min(610, area.height - 24) : 44
    window.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8, width, height })
  }
  function setExpanded(value, focus = false) {
    expanded = value
    position()
    if (focus) { window.show(); window.focus() }
    push()
  }
  async function privateDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') return
    const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 })
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0]
    if (!sid) throw new Error('无法确认当前 Windows 用户的数据权限')
    await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 5000 })
  }
  function safeHandle(name, handler, mutates = false) {
    ipcMain.handle(`guardnook:${name}`, async (event, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== uiURL) throw new Error('不允许的调用来源')
      if (JSON.stringify(input ?? null).length > 1024 * 1024) return { ok: false, error: '请求过大' }
      try { return { ok: true, value: await (mutates ? enqueue(() => handler(input)) : handler(input)) } }
      catch (error) { return { ok: false, error: /[\u3400-\u9fff]/.test(error.message) ? error.message : '操作未完成，请检查节点、接口、权限和端口设置。' } }
    })
  }
  async function refreshApps() {
    if (scanPending) return scanPending
    scanPending = (async () => {
      try {
        const scanned = await scanApps()
        catalogue = normalizeApps([...scanned, ...store.get().customApps])
        scanError = null
      } catch { scanError = '无法读取开始菜单。可稍后刷新，或手动添加应用。' }
      push()
      return publicApps()
    })().finally(() => { scanPending = undefined })
    return scanPending
  }
  async function publicApps() {
    return Promise.all(catalogue.map(async row => {
      let icon = ''
      if (row.iconPath) try { icon = (await app.getFileIcon(row.iconPath, { size: 'normal' })).toDataURL() } catch {}
      return { id: row.id, name: row.name, icon }
    }))
  }
  async function networkProbes() {
    if (probePending) return probePending
    probePending = (async () => {
      const trace = async (name, url, availability) => {
        const at = Date.now()
        try {
          const response = await net.fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const text = (await response.text()).slice(0, 65536)
          const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim() || text.trim()
          if (!isIP(ip)) throw new Error('响应缺少有效出口 IP')
          if (availability) {
            const page = await net.fetch(availability, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) })
            await page.body?.cancel()
            if (!page.ok) throw new Error(`网页访问 HTTP ${page.status}`)
          }
          return [name, { at, ok: true, ip, location: text.match(/^loc=(.+)$/m)?.[1] || '', source: new URL(url).hostname }]
        } catch (error) { return [name, { at, ok: false, ip: null, reason: /HTTP|有效/.test(error.message) ? error.message : '连接失败或超时', source: new URL(url).hostname }] }
      }
      probes = Object.fromEntries(await Promise.all([
        trace('claude', 'https://claude.ai/cdn-cgi/trace', 'https://claude.ai/login'),
        trace('codex', 'https://chatgpt.com/cdn-cgi/trace', 'https://chatgpt.com/'),
        trace('ipv4', 'https://api4.ipify.org'), trace('cloudflare', 'https://<IP>/cdn-cgi/trace'),
      ]))
      push(); return probes
    })().finally(() => { probePending = undefined })
    return probePending
  }
  function installHandlers() {
    safeHandle('boot', async () => ({ ...snapshot(), version: app.getVersion(), settings: runtime.settings(), login: app.getLoginItemSettings().openAtLogin, displays: screen.getAllDisplays().map(d => ({ id: d.id, label: d.label || `${d.size.width} × ${d.size.height}` })), platform: process.platform }))
    safeHandle('board', async action => {
      board = updateBoard(store.get(), action)
      await store.set(board); applyTheme(); position(); push(); return board
    }, true)
    safeHandle('apps', input => input?.refresh ? refreshApps() : publicApps())
    safeHandle('launch', async id => {
      const selected = catalogue.find(row => row.id === id)
      if (!selected) throw new Error('应用已不存在，请刷新应用列表')
      if (selected.kind === 'uwp') {
        if (!/^[a-zA-Z0-9_.!\-]+$/.test(selected.path)) throw new Error('应用标识无效')
        await exec('explorer.exe', [`shell:AppsFolder\\${selected.path}`], { windowsHide: true, timeout: 5000 }).catch(error => { if (error.code !== 1) throw error })
      } else {
        const failure = await shell.openPath(selected.path)
        if (failure) throw new Error('应用无法启动，快捷方式可能已失效')
      }
      if (!board.pinned) setExpanded(false)
    })
    safeHandle('add-app', async () => {
      const result = await dialog.showOpenDialog(window, { title: '添加应用', properties: ['openFile'], filters: [{ name: 'Windows 应用', extensions: ['exe', 'lnk'] }] })
      if (result.canceled) return null
      const path = result.filePaths[0]
      if (!['.exe', '.lnk'].includes(extname(path).toLowerCase()) || !(await stat(path)).isFile()) throw new Error('请选择 EXE 或 LNK 文件')
      const name = path.replaceAll('\\', '/').split('/').pop().replace(/\.(exe|lnk)$/i, '')
      board.customApps = normalizeApps([...board.customApps, { id: path, path, iconPath: path, name, kind: 'file' }])
      await store.set(board); return refreshApps()
    }, true)
    safeHandle('catalogue', input => runtime.catalogue(input || {}))
    safeHandle('pick-script', async () => {
      const result = await dialog.showOpenDialog(window, { title: '选择加入 GuardNook 之前的原始 Clash 扩展脚本', properties: ['openFile'], filters: [{ name: 'JavaScript', extensions: ['js'] }] })
      if (result.canceled) return scriptName
      const info = await stat(result.filePaths[0])
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('脚本应为不超过 2 MB 的 JS 文件')
      originalScript = await readFile(result.filePaths[0], 'utf8')
      scriptName = result.filePaths[0].replaceAll('\\', '/').split('/').pop()
      return scriptName
    })
    safeHandle('save-setup', async input => {
      const result = await runtime.save(input, originalScript)
      originalScript = undefined; scriptName = ''; push(); return result
    }, true)
    safeHandle('reveal-script', async () => {
      const manifest = await readJSON(join(directory, 'SETUP.json'), null)
      if (!manifest?.scriptPath?.startsWith(join(directory, 'Profiles') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('请先保存节点配置')
      shell.showItemInFolder(manifest.scriptPath)
    })
    safeHandle('guard', async action => { const result = await runtime.action(action); push(); return result }, true)
    safeHandle('probes', networkProbes)
    safeHandle('window', action => {
      if (action === 'expand') setExpanded(true, true)
      else if (action === 'collapse') setExpanded(false)
      else throw new Error('未知窗口操作')
    })
    safeHandle('login', enabled => {
      if (typeof enabled !== 'boolean') throw new Error('启动设置无效')
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
      return app.getLoginItemSettings().openAtLogin
    }, true)
    safeHandle('open-data', async () => { const error = await shell.openPath(directory); if (error) throw new Error('数据目录无法打开') })
    safeHandle('export-data', async () => {
      const result = await dialog.showSaveDialog(window, { title: '导出待办与随手记（不含节点和密钥）', defaultPath: 'GuardNook-board-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (!result.canceled) await atomicJSON(result.filePath, { ...store.get(), customApps: [] })
      return !result.canceled
    })
    safeHandle('quit', () => { app.quit() })
  }
  async function ready() {
    await privateDirectory()
    store = await openStorage(directory); board = store.get(); applyTheme()
    runtime = await createRuntime(serviceDirectory, directory)
    await runtime.start().catch(() => {})
    window = new BrowserWindow({ width: 228, height: 44, frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, icon: iconPath,
      webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } })
    window.setAlwaysOnTop(true, 'floating')
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    window.on('close', event => { if (!quitting) { event.preventDefault(); setExpanded(false) } })
    installHandlers()
    await window.loadFile(uiPath)
    position(); window.showInactive()
    if (!runtime.settings() || smoke) setExpanded(true, smoke)
    const trayImage = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 })
    tray = new Tray(trayImage); tray.setToolTip('GuardNook · 悬浮工作台与 Claude 守护')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '展开 GuardNook', click: () => setExpanded(true, true) },
      { label: '收起面板', click: () => setExpanded(false) },
      { type: 'separator' }, { label: '退出 GuardNook', click: () => app.quit() },
    ]))
    tray.on('click', () => setExpanded(!expanded, true))
    globalShortcut.register('CommandOrControl+Alt+Space', () => setExpanded(!expanded, true))
    screen.on('display-metrics-changed', position); screen.on('display-removed', position)
    nativeTheme.on('updated', push)
    timer = setInterval(() => { push() }, 1000)
    hoverTimer = setInterval(() => {
      const { x, y } = screen.getCursorScreenPoint(), bounds = window.getBounds()
      const inside = x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height
      if (!expanded && inside) { if (!hoverSince) hoverSince = Date.now(); else if (Date.now() - hoverSince > 220) setExpanded(true) }
      else if (expanded && !inside && !board.pinned && !window.isFocused()) { if (!hoverSince) hoverSince = Date.now(); else if (Date.now() - hoverSince > 900) setExpanded(false) }
      else hoverSince = 0
    }, 120)
    void refreshApps()
    if (smoke) {
      await window.webContents.executeJavaScript('window.guardnookReady')
      try {
        const script = await readFile(join(here, '../tests/smoke-renderer.js'), 'utf8')
        const result = await window.webContents.executeJavaScript(script)
        await writeFile(join(directory, 'smoke.png'), (await window.webContents.capturePage()).toPNG())
        await writeFile(join(directory, 'smoke.json'), JSON.stringify(result, null, 2))
        console.log(JSON.stringify(result))
        app.quit()
      } catch (error) { console.error('Electron smoke failed:', error.message); await runtime.stop(); app.exit(1) }
    }
  }
  app.on('second-instance', () => { if (window) setExpanded(true, true) })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault(); quitting = true
    clearInterval(timer); clearInterval(hoverTimer); globalShortcut.unregisterAll()
    void mutation.finally(() => runtime?.stop()).catch(() => {}).finally(() => { tray?.destroy(); app.quit() })
  })
  app.whenReady().then(ready).catch(error => {
    dialog.showErrorBox('GuardNook 无法启动', /[\u3400-\u9fff]/.test(error.message) ? error.message : '请检查安装文件和本机数据目录的权限。')
    app.quit()
  })
}
