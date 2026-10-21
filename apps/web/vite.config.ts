import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'LLMR_')
  return {
    plugins: [react(), { name: 'development-auth-mode', transformIndexHtml: (html: string) =>
      env.LLMR_AUTH_MODE === 'oidc' ? html.replace('</head>', '<script>window.__LLMR_AUTH_REQUIRED__=true</script></head>') : html }],
    server: {
      host: '127.0.0.1',
      port: Number(env.LLMR_WEB_PORT || 5173),
      strictPort: true,
      proxy: Object.fromEntries(['/api', '/auth', '/docs', '/openapi.json', '/redoc'].map((path) => [path, env.LLMR_API_PROXY_TARGET || 'http://127.0.0.1:8000'])),
    },
  }
})
