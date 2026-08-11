import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      'generated-tool-worker': resolve(__dirname, 'src/main/generated-tools/runtime/worker.mjs'),
      'user-owned-full-trust-worker': resolve(__dirname, 'src/main/generated-tools/runtime/user-owned-full-trust-worker.mjs'),
      'document-extract-runtime': resolve(__dirname, 'src/main/generated-tools/runtime/document-extract-runtime.mts'),
      'browser-inspect-runtime': resolve(__dirname, 'src/main/generated-tools/runtime/browser-inspect-runtime.mts'),
      'sandbox-runtime': resolve(__dirname, 'src/main/generated-tools/runtime/sandbox-runtime.mts')
    } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts'), markdown: resolve(__dirname, 'src/preload/markdown.ts') } } }
  },
  renderer: {
    root: 'src/renderer',
    publicDir: resolve(__dirname, 'src/image'),
    server: {
      watch: {
        ignored: ['**/.joker/**', '**/.joker-runtime/**', '**/.project-memory/**']
      }
    },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), markdown: resolve(__dirname, 'src/renderer/markdown.html') } } },
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared') } },
    plugins: [react()]
  }
})
