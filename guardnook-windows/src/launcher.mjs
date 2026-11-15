import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const exec = promisify(execFile)
// Fixed script, never interpolates application names or renderer input.
export const SCAN_SCRIPT = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$roots = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
$items = @()
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        if ($shortcut.TargetPath -match '(?i)\\.exe$' -and $_.BaseName -notmatch '(?i)uninstall|卸载') {
          $items += [PSCustomObject]@{ id=$_.FullName; name=$_.BaseName; path=$_.FullName; iconPath=$shortcut.TargetPath; kind='shortcut' }
        }
      } catch {}
    }
  }
}
try {
  Get-StartApps | Where-Object { $_.AppID -match '!' } | ForEach-Object {
    $items += [PSCustomObject]@{ id=('uwp:' + $_.AppID); name=$_.Name; path=$_.AppID; iconPath=''; kind='uwp' }
  }
} catch {}
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
`
export function normalizeApps(rows) {
  if (!Array.isArray(rows)) throw new Error('应用列表格式无效')
  const seen = new Set()
  return rows.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string' && row.name
    && typeof row.path === 'string' && ['shortcut', 'uwp', 'file', 'mac'].includes(row.kind)
    && !seen.has(row.id.toLowerCase()) && seen.add(row.id.toLowerCase()))
    .map(({ id, name, path, kind, iconPath = '' }) => ({ id, name, path, kind, iconPath }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}
export async function scanApps(platform = process.platform, execute = exec) {
  if (platform === 'win32') {
    const encoded = Buffer.from(SCAN_SCRIPT, 'utf16le').toString('base64')
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 25000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' })
    return normalizeApps(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()))
  }
  // Useful for development only; Windows packages always take the branch above.
  const paths = ['/Applications', '/System/Applications', '/System/Applications/Utilities']
  const rows = []
  for (const directory of paths) {
    for (const name of await readdir(directory).catch(() => [])) if (name.endsWith('.app')) rows.push({ id: join(directory, name), path: join(directory, name), name: name.slice(0, -4), kind: 'mac', iconPath: join(directory, name) })
  }
  return normalizeApps(rows)
}
