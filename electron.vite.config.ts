import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    server: { host: '127.0.0.1' }
  }
})
