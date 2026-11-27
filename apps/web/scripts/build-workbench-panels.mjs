import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const inline = process.argv.includes('--inline')
const directory = process.argv.slice(2).find(arg => arg !== '--inline')
const output = resolve(directory ?? resolve(webRoot, inline ? '../../artifacts/windows-workbench/inline-panels' : '../../artifacts/kairos-workbench/shared-panels'))
await mkdir(output, { recursive: true })
await build({
  configFile: false, root: webRoot, publicDir: false,
  build: {
    target: 'es2022', outDir: output, emptyOutDir: false, cssCodeSplit: false,
    lib: { entry: resolve(webRoot, 'src/workbench-panels/frame.ts'), name: 'WorkbenchPanels', formats: ['iife'],
      fileName: () => 'workbench-panel.js', cssFileName: 'workbench-panel' },
  },
})
await Promise.all(['workbench-panel.js', 'workbench-panel.css'].map(file => access(resolve(output, file))))
