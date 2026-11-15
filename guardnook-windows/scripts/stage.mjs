import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, '../guardnook')
await rm(join(root, 'staged'), { recursive: true, force: true })
await mkdir(join(root, 'staged/Licenses'), { recursive: true })
await cp(join(source, 'Service'), join(root, 'staged/Service'), { recursive: true, filter: path => !path.endsWith('.test.mjs') && !path.endsWith('README.md') && !path.endsWith('/fixtures') })
await cp(join(source, 'LICENSE'), join(root, 'staged/Licenses/GuardNook-MIT.txt'))
console.log('Staged current GuardNook service; tests, fixtures and personal settings excluded.')
