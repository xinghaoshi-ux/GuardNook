import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Node resolves an ESM module's URL through symlinks. argv may still contain the
// user's /var, /Volumes, or app alias path, so lexical path equality is unsafe.
export function isMainModule(url) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(url) }
  catch { return false }
}
