import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5174,
    proxy: {
      // Proxy all /api/* calls to the local API server during development
      '/api': {
        target:       'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
})
