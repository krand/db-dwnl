const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')

function compile(path) {
  return ts.transpileModule(readFileSync(join(__dirname, '..', path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function renderer() {
  const timers = new Map()
  const windowEvents = {}
  const documentEvents = {}
  let nextTimer = 0
  let appRenders = 0
  let activityRenders = 0
  let tree
  let activityHTML = ''
  const log = { scrollTop: 0 }
  const activity = {
    querySelector: () => log,
    set innerHTML(value) { activityHTML = value; activityRenders++ }
  }
  const app = {
    set innerHTML(value) {
      appRenders++
      tree = { scrollTop: 0, scrollLeft: 0 }
      activityHTML = value
    }
  }
  const context = {
    exports: {}, require() {},
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
    document: {
      hidden: false,
      addEventListener: (name, callback) => { documentEvents[name] = callback },
      querySelector: selector => ({ '#app': app, '#tree': tree, '.activity': activity })[selector] ?? null,
      querySelectorAll: () => []
    },
    window: {
      addEventListener: (name, callback) => { windowEvents[name] = callback },
      dropboxApp: { onProgress() {}, getSettings: () => new Promise(() => {}) }
    }
  }
  vm.runInNewContext(compile('src/renderer/src/main.ts') + '\nglobalThis.api = { state, addLog, render };', context)
  return {
    ...context.api, timers, windowEvents, documentEvents, document: context.document, log,
    get tree() { return tree },
    get appRenders() { return appRenders },
    get activityRenders() { return activityRenders },
    get html() { return activityHTML },
    flush() { for (const callback of [...timers.values()]) callback() }
  }
}

test('chunk bursts update only the activity panel and preserve completed-file messages', () => {
  const ui = renderer()
  const tree = ui.tree
  tree.scrollTop = 600
  ui.addLog({ type: 'success', message: 'Finished /first.txt', completedFiles: 1, totalFiles: 2, bytesDone: 100, totalBytes: 1000 })
  for (let i = 0; i < 10000; i++) {
    ui.addLog({ type: 'progress', message: 'Downloading second.txt', bytesDone: 100 + i / 20 })
  }
  assert.equal(ui.appRenders, 1)
  assert.equal(ui.timers.size, 1)
  assert.equal(ui.state.logs.length, 1)
  ui.flush()
  assert.equal(ui.activityRenders, 1)
  assert.equal(ui.tree, tree)
  assert.equal(tree.scrollTop, 600)
  assert.match(ui.html, /Finished \/first.txt/)
  assert.match(ui.html, /Downloading second.txt/)
  assert.match(ui.html, /1 of 2 files/)
  assert.equal(ui.timers.size, 0)
})

test('reactivating the window immediately paints the latest progress', () => {
  const ui = renderer()
  ui.addLog({ type: 'progress', message: 'Downloading file', bytesDone: 750, totalBytes: 1000 })
  ui.windowEvents.focus()
  assert.match(ui.html, /75% complete/)
  assert.equal(ui.timers.size, 0)
  ui.addLog({ type: 'progress', message: 'Downloading file', bytesDone: 900 })
  ui.document.hidden = true
  ui.documentEvents.visibilitychange()
  assert.equal(ui.timers.size, 1)
  ui.document.hidden = false
  ui.documentEvents.visibilitychange()
  assert.match(ui.html, /90% complete/)
  assert.equal(ui.appRenders, 1)
})

test('errors and unrelated messages preserve transfer counters', () => {
  const ui = renderer()
  ui.addLog({ type: 'success', message: 'Finished file', completedFiles: 3, totalFiles: 5, bytesDone: 500, totalBytes: 1000 })
  ui.addLog({ type: 'error', message: 'Connection failed' })
  ui.flush()
  assert.match(ui.html, /3 of 5 files/)
  assert.match(ui.html, /50% complete/)
  assert.match(ui.html, /Connection failed/)
})

test('activity history is bounded and full UI redraws cancel pending activity work', () => {
  const ui = renderer()
  for (let i = 0; i < 1000; i++) ui.addLog({ type: 'success', message: `Finished ${i}` })
  assert.equal(ui.state.logs.length, 200)
  assert.equal(ui.state.logs[0].message, 'Finished 800')
  ui.render()
  assert.equal(ui.timers.size, 0)
  assert.match(ui.html, /Finished 999/)
})

test('the main process limits byte events while delivering every file completion', () => {
  const sent = []
  let windowOptions
  let clock = 0
  let destroyed = false
  const electron = {
    app: { whenReady: () => ({ then: callback => callback() }), on() {} },
    ipcMain: { handle() {} },
    BrowserWindow: class {
      constructor(options) { windowOptions = options; this.webContents = { send: (_channel, event) => sent.push(event) } }
      loadURL() {}
      isDestroyed() { return destroyed }
    }
  }
  const context = {
    exports: {}, __dirname, process,
    require: name => name === 'electron' ? electron : name === 'dropbox' ? {} : require(name),
    Date: { now: () => clock }
  }
  vm.runInNewContext(compile('src/main/index.ts') + '\nglobalThis.emit = emitProgress;', context)
  assert.equal(windowOptions.webPreferences.backgroundThrottling, false)
  for (clock = 0; clock < 1000; clock++) context.emit({ type: 'progress', message: 'Downloading', bytesDone: clock })
  assert.equal(sent.length, 10)
  for (let i = 0; i < 10; i++) context.emit({ type: 'success', message: `Finished ${i}` })
  assert.equal(sent.length, 20)
  context.emit({ type: 'error', message: 'Connection failed' })
  assert.equal(sent.at(-1).message, 'Connection failed')
  destroyed = true
  assert.doesNotThrow(() => context.emit({ type: 'success', message: 'Download complete' }))
  assert.equal(sent.length, 21)
})

test('individually selected files contribute their size to live progress', async () => {
  const sent = []
  const blockers = []
  const electron = {
    app: { whenReady: () => ({ then() {} }), on() {} },
    powerSaveBlocker: { start: () => 0, stop: id => blockers.push(id) }
  }
  const context = {
    Error, exports: {}, __dirname, process, Date,
    require: name => {
      if (name === 'electron') return electron
      if (name === 'dropbox') return { downloadFile: async (_dbx, _path, _destination, options) => options.progress({ bytesWritten: 1024 }) }
      if (name === 'node:fs/promises') return { mkdir: async () => {} }
      return require(name)
    },
    windowStub: { isDestroyed: () => false, webContents: { send: (_channel, event) => sent.push(event) } }
  }
  vm.runInNewContext(compile('src/main/index.ts') + `
    mainWindow = globalThis.windowStub;
    client = async () => ({});
    validConfig = async () => ({ downloads: {} });
    removeStalePartial = async () => {};
    existsAtCorrectSize = async () => false;
    ensureFreeSpace = async () => {};
    globalThis.run = startDownload;
  `, context)
  await context.run([{ name: 'file', kind: 'file', pathDisplay: '/file', pathLower: '/file', size: 1024 }], '/unused')
  assert.equal(sent.find(event => event.type === 'progress').totalBytes, 1024)
  assert.equal(sent.find(event => event.type === 'progress').bytesDone, 1024)
  assert.equal(sent.at(-1).completedFiles, 1)
  assert.equal(sent.at(-1).totalBytes, 1024)
  assert.deepEqual(blockers, [0])
})
