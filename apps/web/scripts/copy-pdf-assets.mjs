import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const destination = resolve(root, 'public/pdf-assets', directory)
  mkdirSync(destination, { recursive: true })
  for (const file of readdirSync(resolve(root, 'node_modules/pdfjs-dist', directory))) {
    copyFileSync(resolve(root, 'node_modules/pdfjs-dist', directory, file), resolve(destination, file))
  }
}
