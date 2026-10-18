import './styles.css'

type TreeNode = DropboxEntry & { loaded?: boolean; expanded?: boolean; loading?: boolean; children?: TreeNode[]; sizeLoading?: boolean; sizeError?: string }

const state: {
  authenticated: boolean
  configured: boolean
  configPath: string
  targetDirectory: string
  roots: TreeNode[]
  selected: Map<string, TreeNode>
  logs: TransferEvent[]
  progress: { completedFiles: number; totalFiles: number; bytesDone: number; totalBytes: number }
  transferMessage: string
  busy: boolean
  downloading: boolean
  treeBusy: boolean
  authInProgress: boolean
} = {
  authenticated: false, configured: false, configPath: '', targetDirectory: '', roots: [], selected: new Map(), logs: [], progress: { completedFiles: 0, totalFiles: 0, bytesDone: 0, totalBytes: 0 }, transferMessage: '', busy: false, downloading: false, treeBusy: false, authInProgress: false
}

let activityRenderTimer: ReturnType<typeof setTimeout> | undefined

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
  const sizeLabel = node.sizeLoading ? 'Calculating…' : node.sizeError ? 'Error' : node.kind === 'file' || node.size !== undefined ? bytes(node.size) : ''
  const sizeTitle = node.sizeError ? `${node.sizeError} Use Show folder size to retry.` : node.kind === 'folder' && node.size !== undefined ? `${node.size.toLocaleString()} bytes, including all subfolders. Use Show folder size to recalculate.` : ''
  return `<div class="tree-wrap">
    <div class="tree-row ${selected ? 'selected' : ''}" style="--depth:${depth}" data-path="${escape(node.pathLower)}">
      <button class="expand" data-expand="${escape(node.pathLower)}" ${node.kind === 'folder' ? '' : 'disabled'}>${chevron}</button>
      <input aria-label="Select ${escape(node.name)}" type="checkbox" data-select="${escape(node.pathLower)}" ${selected ? 'checked' : ''} />
      <span class="kind">${node.kind === 'folder' ? '▰' : '▱'}</span><span class="node-name">${escape(node.name)}</span>
      <span class="node-size" ${node.kind === 'folder' ? 'role="status"' : ''} title="${escape(sizeTitle)}">${sizeLabel}</span>
      ${node.kind === 'folder' ? `<button class="folder-actions" data-folder-actions="${escape(node.pathLower)}" aria-label="Actions for ${escape(node.name)}" aria-haspopup="menu" title="Folder actions" ${node.sizeLoading ? 'disabled' : ''}>⋯</button>` : '<span></span>'}
    </div>${children}
  </div>`
}

function activityMarkup(): string {
  const { completedFiles, totalFiles, bytesDone, totalBytes } = state.progress
  const percent = totalBytes ? Math.min(100, Math.round(bytesDone / totalBytes * 100)) : 0
  return `<div class="section-head"><div><h2>Transfer progress</h2><p>${percent}% complete</p></div><strong>${percent}%</strong></div><div class="meter"><i style="width:${percent}%"></i></div>
    <div class="summary">${completedFiles} of ${totalFiles} files · ${bytes(bytesDone)} of ${bytes(totalBytes)}${state.transferMessage ? `<br />${escape(state.transferMessage)}` : ''}</div>
    <div class="log">${state.logs.length ? state.logs.slice().reverse().map((log) => `<p class="${log.type}"><b>${log.type === 'error' ? '!' : log.type === 'success' ? '✓' : '·'}</b>${escape(log.message)}</p>`).join('') : '<p class="quiet">Transfer messages will appear here.</p>'}</div>`
}

function renderActivity(): void {
  clearTimeout(activityRenderTimer)
  activityRenderTimer = undefined
  const activity = document.querySelector<HTMLDivElement>('.activity')
  if (activity) {
    const scrollTop = activity.querySelector<HTMLDivElement>('.log')?.scrollTop ?? 0
    activity.innerHTML = activityMarkup()
    activity.querySelector<HTMLDivElement>('.log')!.scrollTop = scrollTop
  }
}

function render(): void {
  clearTimeout(activityRenderTimer)
  activityRenderTimer = undefined
  const treeDisabled = state.treeBusy || state.downloading
  const previousTree = document.querySelector<HTMLDivElement>('#tree')
  const treeScrollTop = previousTree?.scrollTop ?? 0
  const treeScrollLeft = previousTree?.scrollLeft ?? 0
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
          <div class="tree-panel" aria-busy="${treeDisabled}">
            <div class="tree" id="tree" ${treeDisabled ? 'inert aria-disabled="true"' : ''}>${state.authenticated ? (state.roots.length ? state.roots.map((node) => nodeMarkup(node)).join('') : '<div class="empty">Loading your Dropbox…</div>') : '<div class="empty">Your file tree will appear here.</div>'}</div>
            ${treeDisabled ? `<div class="tree-blocker" role="status" aria-live="polite"><div class="tree-loading">${state.downloading ? '' : '<div class="tree-progress"><i></i></div>'}<span>${state.downloading ? 'Download in progress. Browsing will resume when it finishes.' : 'Loading folder…'}</span></div></div>` : ''}
          </div>
        </div>
        <div class="side">
          <div class="card destination"><div class="section-head"><div><h2>Save to</h2><p>Choose a folder on your computer.</p></div></div>
            <div class="path"><span title="${escape(state.targetDirectory)}">${state.targetDirectory ? escape(state.targetDirectory) : 'No destination selected'}</span><button id="choose-folder" ${state.busy ? 'disabled' : ''}>Choose folder</button></div>
            <button id="download" class="download" ${!state.authenticated || !state.targetDirectory || !state.selected.size || state.busy ? 'disabled' : ''}>${state.busy ? 'Downloading…' : `Download ${state.selected.size || ''}`}</button>
          </div>
          <div class="card activity">${activityMarkup()}</div>
        </div>
      </section>
    </main>`
  const tree = document.querySelector<HTMLDivElement>('#tree')!
  tree.scrollTop = treeScrollTop
  tree.scrollLeft = treeScrollLeft
  bindEvents()
}

function findNode(path: string, nodes = state.roots): TreeNode | undefined {
  for (const node of nodes) {
    if (node.pathLower === path) return node
    const nested = node.children && findNode(path, node.children)
    if (nested) return nested
  }
}

async function loadChildren(node: TreeNode, refresh = false): Promise<void> {
  if ((!refresh && node.loaded) || state.treeBusy || state.downloading) return
  state.treeBusy = true
  node.loading = true; render()
  try {
    const entries = await window.dropboxApp.listFolder(node.pathDisplay)
    const previous = new Map(node.children?.map((child) => [child.pathLower, child]))
    const children = entries.map((entry): TreeNode => {
      const existing = previous.get(entry.pathLower)
      if (existing?.id === entry.id && existing?.kind === entry.kind) {
        previous.delete(entry.pathLower)
        Object.assign(existing, entry)
        return existing
      }
      return { ...entry }
    })
    for (const removed of previous.values()) {
      for (const path of state.selected.keys()) {
        if (path === removed.pathLower || path.startsWith(`${removed.pathLower}/`)) state.selected.delete(path)
      }
    }
    node.children = children; node.loaded = true
    if (refresh) {
      node.expanded = true
      // Any containing folder's previous total may now be out of date.
      const invalidateSize = (nodes: TreeNode[]): void => {
        for (const folder of nodes) {
          if (folder.kind === 'folder' && (node.pathLower === folder.pathLower || node.pathLower.startsWith(`${folder.pathLower}/`))) {
            folder.size = undefined; folder.sizeError = undefined
          }
          if (folder.children) invalidateSize(folder.children)
        }
      }
      invalidateSize(state.roots)
    }
  }
  catch (error) { addLog({ type: 'error', message: error instanceof Error ? error.message : 'Could not load folder.' }) }
  finally { node.loading = false; state.treeBusy = false; render() }
}

async function loadRootEntries(): Promise<void> {
  state.treeBusy = true; render()
  try { state.roots = (await window.dropboxApp.listFolder('')).map((entry) => ({ ...entry })) }
  finally { state.treeBusy = false; render() }
}

async function showFolderSize(node: TreeNode): Promise<void> {
  if (node.sizeLoading || state.downloading) return
  node.sizeLoading = true; node.sizeError = undefined; render()
  try { node.size = await window.dropboxApp.getFolderSize(node.pathDisplay) }
  catch (error) {
    node.sizeError = error instanceof Error ? error.message : 'Could not calculate folder size.'
    addLog({ type: 'error', message: `Could not calculate size of ${node.name}: ${node.sizeError}` })
  } finally { node.sizeLoading = false; render() }
}

function addLog(event: TransferEvent): void {
  for (const key of ['completedFiles', 'totalFiles', 'bytesDone', 'totalBytes'] as const) {
    if (event[key] !== undefined) state.progress[key] = event[key]
  }
  state.transferMessage = event.message
  if (event.type !== 'progress') {
    state.logs.push(event)
    if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200)
  }
  if (activityRenderTimer === undefined) activityRenderTimer = setTimeout(renderActivity, 100)
}

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
    await loadRootEntries()
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
    if (state.busy) return
    state.busy = true; state.downloading = true; state.logs = []
    state.progress = { completedFiles: 0, totalFiles: 0, bytesDone: 0, totalBytes: 0 }; state.transferMessage = ''; render()
    try { await window.dropboxApp.startDownload([...state.selected.values()], state.targetDirectory) }
    catch { /* The main process already supplied an actionable log event. */ }
    finally { state.busy = false; state.downloading = false; render() }
  })
  document.querySelectorAll<HTMLButtonElement>('[data-expand]').forEach((button) => button.addEventListener('click', async () => {
    if (state.treeBusy || state.downloading) return
    const node = findNode(button.dataset.expand!); if (!node) return
    node.expanded = !node.expanded
    if (node.expanded) await loadChildren(node)
    render()
  }))
  document.querySelectorAll<HTMLInputElement>('[data-select]').forEach((box) => box.addEventListener('change', () => {
    if (state.treeBusy || state.downloading) return
    const node = findNode(box.dataset.select!); if (!node) return
    if (box.checked) state.selected.set(node.pathLower, node); else state.selected.delete(node.pathLower)
    render()
  }))
  document.querySelectorAll<HTMLButtonElement>('[data-folder-actions]').forEach((button) => button.addEventListener('click', async () => {
    if (state.treeBusy || state.downloading) return
    const node = findNode(button.dataset.folderActions!); if (!node || node.sizeLoading) return
    try {
      const action = await window.dropboxApp.showFolderActions()
      if (action === 'show-folder-size') await showFolderSize(node)
      else if (action === 'refresh') await loadChildren(node, true)
    } catch (error) {
      addLog({ type: 'error', message: error instanceof Error ? error.message : 'Could not open folder actions.' })
    }
  }))
}

window.dropboxApp.onProgress(addLog)
window.addEventListener('focus', renderActivity)
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderActivity() })
window.dropboxApp.getSettings().then(async (settings) => {
  state.configured = settings.configured; state.configPath = settings.configPath; state.authenticated = settings.authenticated
  if (state.authenticated) {
    try { await loadRootEntries() }
    catch (error) { state.authenticated = false; addLog({ type: 'error', message: error instanceof Error ? error.message : 'Saved Dropbox session could not be restored.' }) }
  }
  render()
})

render()
