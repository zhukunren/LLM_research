import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const destination = resolve(root, 'public/pdf-assets', directory)
  mkdirSync(destination, { recursive: true })
  for (const file of readdirSync(resolve(root, 'node_modules/pdfjs-dist', directory))) {
    const source = resolve(root, 'node_modules/pdfjs-dist', directory, file)
    const target = resolve(destination, file)
    // Keep the prebuild idempotent: unchanged assets are not rewritten, so a
    // build does not need write access to already-correct copied files.
    if (existsSync(target) && readFileSync(source).equals(readFileSync(target))) continue
    copyFileSync(source, target)
  }
}
