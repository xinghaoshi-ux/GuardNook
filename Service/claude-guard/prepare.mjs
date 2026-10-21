import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Script } from 'node:vm'
import { composeProfileScript } from './profile.mjs'

const [source, output, configPath] = process.argv.slice(2)
if (!source || !output || !configPath || resolve(source) === resolve(output) || resolve(configPath) === resolve(output)) {
  console.error('Usage: node apps/claude-guard/prepare.mjs SOURCE_SCRIPT NEW_OUTPUT_SCRIPT PRIVATE_CONFIG_JSON')
  process.exitCode = 1
} else {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const script = composeProfileScript(await readFile(source, 'utf8'), config)
    new Script(script, { filename: 'claude-guard-generated.js' })
    await writeFile(output, script, { mode: 0o600, flag: 'wx' })
    console.log('Combined script written to a new file. Current Clash configuration was not changed.')
  } catch { console.error('Preparation failed; source/output/config must be valid and output must be a new file.'); process.exitCode = 1 }
}
