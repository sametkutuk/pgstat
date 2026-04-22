import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    // API isteklerini backend'e yönlendir
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
