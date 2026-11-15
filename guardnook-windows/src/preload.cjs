const { contextBridge, ipcRenderer } = require('electron')
const calls = ['boot', 'board', 'apps', 'launch', 'add-app', 'catalogue', 'save-setup', 'pick-script', 'reveal-script', 'guard', 'probes', 'window', 'login', 'open-data', 'export-data', 'quit']
contextBridge.exposeInMainWorld('guardnook', Object.fromEntries(calls.map(name => [name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), input => ipcRenderer.invoke(`guardnook:${name}`, input)])))
contextBridge.exposeInMainWorld('guardnookEvents', {
  onState(callback) {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('guardnook:state', listener)
    return () => ipcRenderer.removeListener('guardnook:state', listener)
  },
})
