import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { SCAN_SCRIPT, scanApps, normalizeApps } from '../src/launcher.mjs'
import { coverageRules } from '../../guardnook/Service/claude-guard/coverage.mjs'
import { portableConfig } from '../../guardnook/Service/claude-guard/setup.mjs'
import { composeProfileScript } from '../../guardnook/Service/claude-guard/profile.mjs'
import { closeClaudeConnections } from '../../guardnook/Service/claude-guard/tun-connections.mjs'

const configuration = () => portableConfig({ targetPlatform: 'win32', controllerSocket: '', controllerURL: 'http://127.0.0.1:9090', expectedIP: '<IP>', selectedProxy: 'selected', requireTun: true }, 'a'.repeat(64))
test('Windows setup retains platform and TUN requirements and accepts only local controller URLs', () => {
  const c = configuration()
  assert.equal(c.targetPlatform, 'win32'); assert.equal(c.requireTun, true)
  assert.throws(() => portableConfig({ ...c, controllerURL: 'http://evil.test:9090' }, 'a'.repeat(64)))
  assert.throws(() => portableConfig({ ...c, targetPlatform: 'other' }, 'a'.repeat(64)))
})
test('generated self-contained Clash script uses executable rules and retains existing intranet behavior', () => {
  const c = { ...configuration(), coverageVersion: 1 }, source = composeProfileScript('function main(c) { c.rules.unshift("DOMAIN,corp.test,DIRECT"); return c; }', c)
  const context = { input: { mode: 'rule', proxies: [{ name: 'selected', type: 'ss', server: 'example.test', port: 443, cipher: 'aes-128-gcm', password: 'sample' }], 'proxy-groups': [], rules: ['MATCH,DIRECT'], tun: { enable: true } } }
  vm.createContext(context); vm.runInContext(source + '\nresult=main(input)', context)
  const result = context.result
  assert.ok(result.rules.includes(`PROCESS-NAME,Claude.exe,${c.policyGroup}`))
  assert.ok(result.rules.includes('DOMAIN,corp.test,DIRECT'))
  assert.ok(result.rules.includes(`AND,((PROCESS-NAME,claude.exe),(NETWORK,UDP)),REJECT`))
  const regex = coverageRules(c).find(r => r.startsWith('PROCESS-PATH-REGEX,')).split(',')[1]
  const windowsPath = new RegExp(regex.replace('(?i)', ''), 'i')
  assert.equal(windowsPath.test('C:\\Users\\Example\\AppData\\Local\\Programs\\Claude\\helper.exe'), true)
  assert.equal(windowsPath.test('C:/Tools/claude-code/helper.exe'), true)
  assert.equal(windowsPath.test('C:\\Tools\\Unrelated\\helper.exe'), false)
  assert.equal(result.tun.enable, true)
  assert.equal(result['proxy-groups'].find(p => p.name === c.policyGroup).proxies[0], 'REJECT')
  assert.equal(source.includes('controllerSecret'), false)
  assert.equal(coverageRules({ ...c, targetPlatform: 'darwin' }).some(r => r.includes('Claude.exe')), false)
})
test('Windows Claude connections are drained on TUN failure without deleting other apps', async () => {
  const deleted = []
  await closeClaudeConnections(configuration(), { request: async (path, method) => {
    if (method === 'DELETE') { deleted.push(path); return {} }
    return { connections: [
      { id: 'claude', metadata: { process: 'Claude.exe', host: 'shared.test' } },
      { id: 'code', metadata: { process: 'claude-code.exe' } },
      { id: 'path', metadata: { process: 'helper.exe', processPath: 'C:\\Users\\Example\\AppData\\Local\\Programs\\Claude\\helper.exe' } },
      { id: 'ordinary', metadata: { process: 'other.exe', host: 'shared.test' } },
    ] }
  } })
  assert.deepEqual(deleted.sort(), ['/connections/claude', '/connections/code', '/connections/path'])
})
test('Windows scanner executes a fixed encoded script and preserves non-ASCII names and shortcut paths', async () => {
  const rows = [{ id: 'C:\\Start Menu\\工具.lnk', path: 'C:\\Start Menu\\工具.lnk', name: '工具', kind: 'shortcut' }, { id: 'uwp:Example!App', path: 'Example!App', name: 'Store 应用', kind: 'uwp' }]
  const apps = await scanApps('win32', async (command, args, options) => {
    assert.equal(command, 'powershell.exe'); assert.equal(args.includes('-NoProfile'), true)
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), SCAN_SCRIPT)
    assert.equal(options.windowsHide, true)
    return { stdout: '\uFEFF' + JSON.stringify(rows) }
  })
  assert.equal(apps.length, 2); assert.ok(apps.some(a => a.name === '工具'))
  assert.equal(normalizeApps([...rows, ...rows, { id: 'invalid' }]).length, 2)
})
