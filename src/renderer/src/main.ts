import './styles.css'

type TreeNode = DropboxEntry & { loaded?: boolean; expanded?: boolean; loading?: boolean; children?: TreeNode[] }

const state: {
  authenticated: boolean
  configured: boolean
  configPath: string
  targetDirectory: string
  roots: TreeNode[]
  selected: Map<string, TreeNode>
  logs: TransferEvent[]
  busy: boolean
  authInProgress: boolean
} = {
  authenticated: false, configured: false, configPath: '', targetDirectory: '', roots: [], selected: new Map(), logs: [], busy: false, authInProgress: false
}

const bytes = (value = 0): string => {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function escape(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!))
}

function nodeMarkup(node: TreeNode, depth = 0): string {
  const selected = state.selected.has(node.pathLower)
  const chevron = node.kind === 'folder' ? (node.loading ? '…' : node.expanded ? '⌄' : '›') : ''
  const children = node.expanded && node.children ? node.children.map((child) => nodeMarkup(child, depth + 1)).join('') : ''
  return `<div class="tree-wrap">
    <div class="tree-row ${selected ? 'selected' : ''}" style="--depth:${depth}" data-path="${escape(node.pathLower)}">
      <button class="expand" data-expand="${escape(node.pathLower)}" ${node.kind === 'folder' ? '' : 'disabled'}>${chevron}</button>
      <input aria-label="Select ${escape(node.name)}" type="checkbox" data-select="${escape(node.pathLower)}" ${selected ? 'checked' : ''} />
      <span class="kind">${node.kind === 'folder' ? '▰' : '▱'}</span><span class="node-name">${escape(node.name)}</span>
      <span class="node-size">${node.kind === 'file' ? bytes(node.size) : ''}</span>
    </div>${children}
  </div>`
}

function render(): void {
  const lastLog = state.logs.at(-1)
  const percent = lastLog?.totalBytes ? Math.min(100, Math.round((lastLog.bytesDone ?? 0) / lastLog.totalBytes * 100)) : 0
  const authPanel = state.authInProgress ? `
    <div class="auth-code"><label for="authorization-code">Authorization code</label><div><input id="authorization-code" placeholder="Paste the code shown by Dropbox" autofocus /><button id="finish-auth" class="primary" ${state.busy ? 'disabled' : ''}>Connect</button></div><p>Approve access in the browser, then paste the code here. <button id="reopen-auth" class="text-button">Open Dropbox again</button></p></div>` : ''
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <main>
      <header><div><p class="eyebrow">DROPBOX DOWNLOAD MANAGER</p><h1>Download what you need.</h1><p class="subhead">Browse your Dropbox, choose a local destination, then let the transfer queue handle the rest.</p></div>
        <div class="auth-status ${state.authenticated ? 'connected' : ''}"><span></span>${state.authenticated ? 'Dropbox connected' : 'Not connected'}</div></header>
      <section class="toolbar card">
        <div class="config-note"><strong>${state.configured ? 'Dropbox app configured' : 'Dropbox app configuration needed'}</strong><p>${state.configured ? 'OAuth and transfer settings are loaded from the app configuration file.' : `Copy app.config.example.json to ${escape(state.configPath || 'the project folder')} and set dropbox.appKey.`}</p></div>
        <button class="primary" id="authenticate" ${state.busy || state.authenticated || !state.configured ? 'disabled' : ''}>${state.authInProgress ? 'Restart authentication' : state.authenticated ? 'Authenticated' : 'Authenticate with Dropbox'}</button>
        ${authPanel}
      </section>
      <section class="workspace">
        <div class="card browser"><div class="section-head"><div><h2>Dropbox files</h2><p>${state.authenticated ? 'Select files or folders to queue for download.' : 'Authenticate to load your Dropbox.'}</p></div><span class="count">${state.selected.size} selected</span></div>
          <div class="tree" id="tree">${state.authenticated ? (state.roots.length ? state.roots.map((node) => nodeMarkup(node)).join('') : '<div class="empty">Loading your Dropbox…</div>') : '<div class="empty">Your file tree will appear here.</div>'}</div>
        </div>
        <div class="side">
          <div class="card destination"><div class="section-head"><div><h2>Save to</h2><p>Choose a folder on your computer.</p></div></div>
            <div class="path"><span title="${escape(state.targetDirectory)}">${state.targetDirectory ? escape(state.targetDirectory) : 'No destination selected'}</span><button id="choose-folder" ${state.busy ? 'disabled' : ''}>Choose folder</button></div>
            <button id="download" class="download" ${!state.authenticated || !state.targetDirectory || !state.selected.size || state.busy ? 'disabled' : ''}>${state.busy ? 'Downloading…' : `Download ${state.selected.size || ''}`}</button>
          </div>
          <div class="card activity"><div class="section-head"><div><h2>Transfer progress</h2><p>${percent}% complete</p></div><strong>${percent}%</strong></div><div class="meter"><i style="width:${percent}%"></i></div>
            <div class="summary">${lastLog?.completedFiles ?? 0} of ${lastLog?.totalFiles ?? 0} files · ${bytes(lastLog?.bytesDone)} of ${bytes(lastLog?.totalBytes)}</div>
            <div class="log">${state.logs.length ? state.logs.slice(-8).reverse().map((log) => `<p class="${log.type}"><b>${log.type === 'error' ? '!' : log.type === 'success' ? '✓' : '·'}</b>${escape(log.message)}</p>`).join('') : '<p class="quiet">Transfer messages will appear here.</p>'}</div>
          </div>
        </div>
      </section>
    </main>`
  bindEvents()
}

function findNode(path: string, nodes = state.roots): TreeNode | undefined {
  for (const node of nodes) {
    if (node.pathLower === path) return node
    const nested = node.children && findNode(path, node.children)
    if (nested) return nested
  }
}

async function loadChildren(node: TreeNode): Promise<void> {
  if (node.loaded) return
  node.loading = true; render()
  try { node.children = (await window.dropboxApp.listFolder(node.pathDisplay)).map((entry) => ({ ...entry })); node.loaded = true }
  catch (error) { addLog({ type: 'error', message: error instanceof Error ? error.message : 'Could not load folder.' }) }
  finally { node.loading = false; render() }
}

function addLog(event: TransferEvent): void { state.logs.push(event); render() }

async function beginAuth(): Promise<void> {
  state.busy = true; render()
  try {
    await window.dropboxApp.beginAuthentication()
    state.authInProgress = true
    addLog({ type: 'info', message: 'Dropbox opened in your browser. Approve access, then paste the authorization code.' })
  } catch (error) {
    addLog({ type: 'error', message: error instanceof Error ? error.message : 'Could not start authentication.' })
  } finally {
    state.busy = false; render()
  }
}

async function finishAuth(): Promise<void> {
  const code = document.querySelector<HTMLInputElement>('#authorization-code')?.value ?? ''
  state.busy = true; render()
  try {
    await window.dropboxApp.finishAuthentication(code)
    state.authenticated = true; state.authInProgress = false
    state.roots = (await window.dropboxApp.listFolder('')).map((entry) => ({ ...entry }))
    addLog({ type: 'success', message: 'Dropbox authenticated. Your files are ready to browse.' })
  } catch (error) {
    addLog({ type: 'error', message: error instanceof Error ? error.message : 'Authentication failed.' })
  } finally {
    state.busy = false; render()
  }
}

function bindEvents(): void {
  document.querySelector('#authenticate')?.addEventListener('click', beginAuth)
  document.querySelector('#reopen-auth')?.addEventListener('click', beginAuth)
  document.querySelector('#finish-auth')?.addEventListener('click', finishAuth)
  document.querySelector('#choose-folder')?.addEventListener('click', async () => { const folder = await window.dropboxApp.chooseDirectory(); if (folder) { state.targetDirectory = folder; render() } })
  document.querySelector('#download')?.addEventListener('click', async () => {
    state.busy = true; state.logs = []; render()
    try { await window.dropboxApp.startDownload([...state.selected.values()], state.targetDirectory) }
    catch { /* The main process already supplied an actionable log event. */ }
    finally { state.busy = false; render() }
  })
  document.querySelectorAll<HTMLButtonElement>('[data-expand]').forEach((button) => button.addEventListener('click', async () => {
    const node = findNode(button.dataset.expand!); if (!node) return
    node.expanded = !node.expanded; if (node.expanded) await loadChildren(node); else render()
  }))
  document.querySelectorAll<HTMLInputElement>('[data-select]').forEach((box) => box.addEventListener('change', () => {
    const node = findNode(box.dataset.select!); if (!node) return
    if (box.checked) state.selected.set(node.pathLower, node); else state.selected.delete(node.pathLower)
    render()
  }))
}

window.dropboxApp.onProgress(addLog)
window.dropboxApp.getSettings().then(async (settings) => {
  state.configured = settings.configured; state.configPath = settings.configPath; state.authenticated = settings.authenticated
  if (state.authenticated) {
    try { state.roots = (await window.dropboxApp.listFolder('')).map((entry) => ({ ...entry })) }
    catch (error) { state.authenticated = false; addLog({ type: 'error', message: error instanceof Error ? error.message : 'Saved Dropbox session could not be restored.' }) }
  }
  render()
})

render()
