import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps' },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts' },
        { src: 'node_modules/pdfjs-dist/wasm/*', dest: 'pdfjs/wasm' },
      ],
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
