import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        // Inject CORP header so the browser (under COEP) accepts the proxied stream
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cross-origin-resource-policy'] = 'cross-origin'
          })
        },
      },
    },
    headers: {
      // SharedArrayBuffer requires a secure context.
      // 'credentialless' is supported in Chrome 96+ and Firefox 119+
      // and does NOT block same-site proxied responses the way 'require-corp' does.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
})
