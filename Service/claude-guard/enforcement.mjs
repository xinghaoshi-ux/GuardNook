import { readFile, writeFile, rename, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { containClaude } from './containment.mjs'

export function createContainmentRepair(c, controller) {
  let pending
  return async () => {
    if (!c.ownedProtection || !c.runtimePath) return false
    if (pending) return pending
    pending = (async () => {
      const rules = await controller.request('/rules')
      if (rules.rules?.[0]?.payload === 'claude.ai' && rules.rules[0].proxy === 'REJECT') return true
      const info = await lstat(c.runtimePath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe runtime path')
      const original = await readFile(c.runtimePath)
      const runtime = JSON.parse(execFileSync('/usr/bin/ruby', ['-ryaml', '-rjson', '-e', 'print JSON.generate(YAML.load_file(ARGV[0]))', c.runtimePath], { encoding: 'utf8' }))
      const prepared = containClaude(runtime)
      const data = execFileSync('/usr/bin/ruby', ['-ryaml', '-rjson', '-e', 'print YAML.dump(JSON.parse(STDIN.read))'], { input: JSON.stringify(prepared) })
      const hash = value => createHash('sha256').update(value).digest('hex')
      if (hash(await readFile(c.runtimePath)) !== hash(original)) throw new Error('Runtime changed during repair')
      await writeFile(c.runtimePath + '.guardnook-reject-tmp', data, { mode: 0o600 })
      await rename(c.runtimePath + '.guardnook-reject-tmp', c.runtimePath)
      await controller.request('/configs?force=true', 'PUT', { path: c.runtimePath })
      const checked = await controller.request('/rules')
      return checked.rules?.[0]?.payload === 'claude.ai' && checked.rules[0].proxy === 'REJECT'
    })().finally(() => { pending = undefined })
    return pending
  }
}
