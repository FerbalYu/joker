import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      'generated-tool-worker': resolve(__dirname, 'src/main/generated-tools/runtime/worker.mjs')
    } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), markdown: resolve(__dirname, 'src/preload/markdown.ts') } } }
  },
  renderer: {
    root: 'src/renderer',
    publicDir: resolve(__dirname, 'src/image'),
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), markdown: resolve(__dirname, 'src/renderer/markdown.html') } } },
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared') } },
    plugins: [react()]
  }
})
