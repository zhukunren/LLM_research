import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(webRoot, '../../artifacts/kairos-workbench/shared-panels')
await mkdir(output, { recursive: true })
await build({
  configFile: false, root: webRoot, publicDir: false, plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2022', outDir: output, emptyOutDir: false, cssCodeSplit: false,
    lib: { entry: resolve(webRoot, 'src/workbench-panels/frame.tsx'), name: 'WorkbenchPanels', formats: ['iife'],
      fileName: () => 'workbench-panel.js', cssFileName: 'workbench-panel' },
  },
})
await Promise.all(['workbench-panel.js', 'workbench-panel.css'].map(file => access(resolve(output, file))))
