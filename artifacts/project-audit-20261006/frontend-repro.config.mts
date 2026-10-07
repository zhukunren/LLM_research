import { defineConfig } from '../../apps/web/node_modules/vitest/dist/config.js'
import react from '../../apps/web/node_modules/@vitejs/plugin-react/dist/index.mjs'

export default defineConfig({
  root: 'D:/项目/LLM_research/apps/web',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['../../artifacts/project-audit-20261006/frontend-repro.test.tsx'],
    restoreMocks: true,
    clearMocks: true,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
