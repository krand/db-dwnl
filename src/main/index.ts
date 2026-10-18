import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
import { Dropbox, downloadFile } from 'dropbox'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const SETTINGS_FILE = () => join(app.getPath('userData'), 'settings.bin')

type TokenSet = { access_token: string; refresh_token?: string; expires_in?: number; expires_at?: number }
type Settings = { tokenAppKey?: string; tokens?: TokenSet }
type AppConfig = {
  dropbox: { appKey: string; authorizationUrl: string; tokenUrl: string; tokenAccessType: 'offline' | 'online'; scopes?: string[] }
  downloads: { parallelDownloads: number; maxAttempts: number; retryDelayMs: number }
}
type DropboxEntry = {
  id: string
  name: string
  pathDisplay: string
  pathLower: string
  kind: 'file' | 'folder'
  size?: number
}
type SelectedItem = Pick<DropboxEntry, 'pathDisplay' | 'pathLower' | 'kind' | 'name'>
type ProgressEvent = { type: 'info' | 'success' | 'error'; message: string; completedFiles?: number; totalFiles?: number; bytesDone?: number; totalBytes?: number }

let mainWindow: BrowserWindow | null = null
let transferRunning = false
let pendingAuth: { appKey: string; verifier: string; state: string } | null = null

const defaultConfig: AppConfig = {
  dropbox: {
    appKey: 'PASTE_YOUR_DROPBOX_APP_KEY_HERE',
    authorizationUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    tokenAccessType: 'offline',
    scopes: ['files.metadata.read', 'files.content.read']
  },
  downloads: { parallelDownloads: 4, maxAttempts: 3, retryDelayMs: 500 }
}

function configPath(): string {
  return process.env.DB_DWNL_CONFIG ?? join(app.isPackaged ? app.getPath('userData') : process.cwd(), 'app.config.json')
}

async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      dropbox: { ...defaultConfig.dropbox, ...parsed.dropbox },
      downloads: { ...defaultConfig.downloads, ...parsed.downloads }
    }
  } catch {
    throw new Error(`Configuration is missing or invalid. Copy app.config.example.json to ${configPath()} and add your Dropbox app key.`)
  }
}

async function validConfig(): Promise<AppConfig> {
  const config = await readConfig()
  if (!config.dropbox.appKey || config.dropbox.appKey === defaultConfig.dropbox.appKey) {
    throw new Error(`Set dropbox.appKey in ${configPath()} before authenticating.`)
  }
  return config
}

function emitProgress(event: ProgressEvent): void {
  mainWindow?.webContents.send('download:progress', event)
}

function encryptedSettings(data: Settings): Buffer {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(JSON.stringify(data))
    : Buffer.from(JSON.stringify(data), 'utf8')
}

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_FILE())
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
    return JSON.parse(text) as Settings
  } catch {
    return {}
  }
}

async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...changes }
  await mkdir(dirname(SETTINGS_FILE()), { recursive: true })
  const temporary = `${SETTINGS_FILE()}.tmp`
  await writeFile(temporary, encryptedSettings(next))
  await rename(temporary, SETTINGS_FILE())
  return next
}

function pkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

async function exchangeToken(params: URLSearchParams, tokenUrl: string): Promise<TokenSet> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const payload = (await response.json()) as TokenSet & { error_description?: string }
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description ?? 'Dropbox did not return an access token.')
  return { ...payload, expires_at: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined }
}

async function accessToken(): Promise<string> {
  const settings = await loadSettings()
  const config = await validConfig()
  if (!settings.tokens?.access_token) throw new Error('Authenticate with Dropbox first.')
  if (settings.tokenAppKey !== config.dropbox.appKey) throw new Error('The configured Dropbox app changed. Authenticate again.')
  if (!settings.tokens.expires_at || settings.tokens.expires_at > Date.now() + 60_000) return settings.tokens.access_token
  if (!settings.tokens.refresh_token) throw new Error('Your Dropbox session has expired. Authenticate again.')
  const refreshed = await exchangeToken(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: settings.tokens.refresh_token, client_id: config.dropbox.appKey
  }), config.dropbox.tokenUrl)
  const tokens = { ...settings.tokens, ...refreshed, refresh_token: settings.tokens.refresh_token }
  await saveSettings({ tokens })
  return tokens.access_token
}

async function client(): Promise<Dropbox> {
  return new Dropbox({ accessToken: await accessToken() })
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message === 'fetch failed') return true
  const cause = (error as Error & { cause?: unknown }).cause
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return false
  const code = (cause as { code?: unknown }).code
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)
}

function errorDescription(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string') return `${error.message} (${code})`
  }
  return error.message
}

async function withNetworkRetry<T>(operation: () => Promise<T>, description: string): Promise<T> {
  const delays = [250, 750, 1500]
  let lastError: unknown
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientNetworkError(error)) {
        throw new Error(`${description} failed: ${errorDescription(error)}`)
      }
      if (attempt === delays.length) break
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  throw new Error(`${description} failed after ${delays.length + 1} attempts: ${errorDescription(lastError)}`)
}

async function beginAuthentication(): Promise<string> {
  const config = await validConfig()
  const verifier = pkceVerifier()
  const state = randomBytes(24).toString('base64url')
  const url = new URL(config.dropbox.authorizationUrl)
  url.searchParams.set('client_id', config.dropbox.appKey)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('token_access_type', config.dropbox.tokenAccessType)
  if (config.dropbox.scopes?.length) url.searchParams.set('scope', config.dropbox.scopes.join(' '))
  url.searchParams.set('code_challenge', pkceChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  pendingAuth = { appKey: config.dropbox.appKey, verifier, state }
  await shell.openExternal(url.toString())
  return url.toString()
}

async function finishAuthentication(code: string): Promise<void> {
  const config = await validConfig()
  if (!pendingAuth || pendingAuth.appKey !== config.dropbox.appKey) throw new Error('Start authentication again before entering the authorization code.')
  const authCode = code.trim()
  if (!authCode) throw new Error('Paste the authorization code from Dropbox.')
  const tokens = await exchangeToken(new URLSearchParams({
    code: authCode, grant_type: 'authorization_code', client_id: pendingAuth.appKey, code_verifier: pendingAuth.verifier
  }), config.dropbox.tokenUrl)
  pendingAuth = null
  await saveSettings({ tokenAppKey: config.dropbox.appKey, tokens })
}

function toEntry(entry: any): DropboxEntry {
  return {
    id: entry.id,
    name: entry.name,
    pathDisplay: entry.path_display ?? entry.path_lower,
    pathLower: entry.path_lower,
    kind: entry['.tag'] === 'folder' ? 'folder' : 'file',
    size: entry.size
  }
}

async function listFolder(path: string): Promise<DropboxEntry[]> {
  const dbx = await client()
  let { result } = await withNetworkRetry(
    () => dbx.filesListFolder({ path, include_deleted: false }),
    `Listing Dropbox folder ${path || '/'}`
  )
  const entries = [...result.entries]
  while (result.has_more) {
    const continuation = await withNetworkRetry(
      () => dbx.filesListFolderContinue({ cursor: result.cursor }),
      `Continuing Dropbox folder listing ${path || '/'}`
    )
    result = continuation.result
    entries.push(...result.entries)
  }
  return entries.map(toEntry).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

async function listFolderRecursive(path: string): Promise<DropboxEntry[]> {
  const dbx = await client()
  let { result } = await withNetworkRetry(
    () => dbx.filesListFolder({ path, recursive: true, include_deleted: false }),
    `Listing Dropbox folder ${path || '/'}`
  )
  const entries = [...result.entries]
  while (result.has_more) {
    const continuation = await withNetworkRetry(
      () => dbx.filesListFolderContinue({ cursor: result.cursor }),
      `Continuing Dropbox folder listing ${path || '/'}`
    )
    result = continuation.result
    entries.push(...result.entries)
  }
  return entries.map(toEntry)
}

async function getFolderSize(path: string): Promise<number> {
  if (typeof path !== 'string') throw new Error('Choose a Dropbox folder to calculate its size.')
  const entries = await listFolderRecursive(path)
  return entries.reduce((total, entry) => total + (entry.kind === 'file' ? entry.size ?? 0 : 0), 0)
}

function normalizedDropboxPath(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/\\+/g, '/').replace(/\/+/g, '/')
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized
}

function safeRelative(base: string, remotePath: string): string {
  const rel = relative(normalizedDropboxPath(base) || sep, normalizedDropboxPath(remotePath))
  if (!rel || rel.startsWith('..') || resolve('/', rel) === '/') throw new Error(`Unsafe Dropbox path: ${remotePath}`)
  return rel
}

async function existsAtCorrectSize(destination: string, size: number | undefined): Promise<boolean> {
  if (size === undefined) return false
  try { return (await stat(destination)).size === size } catch { return false }
}

async function removeStalePartial(destination: string): Promise<void> {
  await rm(`${destination}.part`, { force: true })
}

async function ensureFreeSpace(destination: string, size: number | undefined): Promise<void> {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) return
  let partialSize = 0
  try { partialSize = (await stat(`${destination}.part`)).size } catch { /* No resumable partial file yet. */ }
  const remaining = Math.max(0, size - partialSize)
  if (!remaining) return

  try {
    const filesystem = await statfs(dirname(destination))
    const available = Number(filesystem.bavail) * Number(filesystem.bsize)
    if (Number.isFinite(available) && available < remaining) {
      throw new Error(`Not enough free disk space for ${destination}: need ${bytesLabel(remaining)}, have ${bytesLabel(available)}.`)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code && ['ENOSYS', 'ENOTSUP', 'ERR_METHOD_NOT_IMPLEMENTED'].includes(code)) return
    throw error
  }
}

function bytesLabel(value: number): string {
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

async function startDownload(items: SelectedItem[], targetDirectory: string): Promise<void> {
  if (transferRunning) throw new Error('A download is already in progress.')
  if (!items.length) throw new Error('Select at least one Dropbox file or folder.')
  if (!targetDirectory) throw new Error('Choose a target folder first.')
  transferRunning = true
  try {
    const files: Array<{ remote: DropboxEntry; destination: string }> = []
    const directories = new Set<string>()
    for (const item of items) {
      if (item.kind === 'file') {
        files.push({ remote: { ...item, id: '', size: undefined }, destination: join(targetDirectory, item.name) })
      } else {
        emitProgress({ type: 'info', message: `Preparing ${item.pathDisplay}…` })
        const basePath = normalizedDropboxPath(item.pathLower)
        const nested = (await listFolderRecursive(item.pathDisplay)).filter((entry) =>
          normalizedDropboxPath(entry.pathLower) !== basePath
        )
        const folderTarget = join(targetDirectory, item.name)
        directories.add(folderTarget)
        for (const entry of nested.filter((entry) => entry.kind === 'folder')) {
          directories.add(join(folderTarget, safeRelative(item.pathDisplay, entry.pathDisplay)))
        }
        for (const entry of nested.filter((entry) => entry.kind === 'file')) {
          files.push({ remote: entry, destination: join(folderTarget, safeRelative(item.pathDisplay, entry.pathDisplay)) })
        }
      }
    }
    for (const directory of directories) await mkdir(directory, { recursive: true })
    const remoteFiles = new Map<string, { remote: DropboxEntry; destination: string }>()
    const destinationOwners = new Map<string, string>()
    for (const file of files) {
      const existingRemote = remoteFiles.get(file.remote.pathLower)
      if (existingRemote) continue
      const owner = destinationOwners.get(file.destination)
      if (owner && owner !== file.remote.pathLower) {
        throw new Error(`Two selected files would overwrite ${file.destination}. Download them separately or select their parent folders.`)
      }
      remoteFiles.set(file.remote.pathLower, file)
      destinationOwners.set(file.destination, file.remote.pathLower)
    }
    files.splice(0, files.length, ...remoteFiles.values())
    const totalBytes = files.reduce((sum, file) => sum + (file.remote.size ?? 0), 0)
    let completedFiles = 0
    let finishedBytes = 0
    emitProgress({ type: 'info', message: `Queued ${files.length} file${files.length === 1 ? '' : 's'}.`, completedFiles, totalFiles: files.length, bytesDone: 0, totalBytes })
    const dbx = await client()
    for (const { remote, destination } of files) {
      await mkdir(dirname(destination), { recursive: true })
      // A new run intentionally starts incomplete files from scratch. The SDK
      // still uses a .part file for retries within this run.
      await removeStalePartial(destination)
      if (await existsAtCorrectSize(destination, remote.size)) {
        completedFiles += 1
        finishedBytes += remote.size ?? 0
        emitProgress({ type: 'info', message: `Skipped existing ${remote.pathDisplay}`, completedFiles, totalFiles: files.length, bytesDone: finishedBytes, totalBytes })
        continue
      }
      await ensureFreeSpace(destination, remote.size)
      emitProgress({ type: 'info', message: `Downloading ${remote.pathDisplay}`, completedFiles, totalFiles: files.length, bytesDone: finishedBytes, totalBytes })
      const config = await validConfig()
      await downloadFile(dbx, remote.pathDisplay, destination, {
        parallelDownloads: config.downloads.parallelDownloads,
        maxAttempts: config.downloads.maxAttempts,
        retryDelay: config.downloads.retryDelayMs,
        progress: ({ bytesWritten }: { bytesWritten: number }) => emitProgress({
          type: 'info', message: `Downloading ${remote.name}`,
          completedFiles, totalFiles: files.length, bytesDone: finishedBytes + bytesWritten, totalBytes
        })
      })
      completedFiles += 1
      finishedBytes += remote.size ?? 0
      emitProgress({ type: 'success', message: `Finished ${remote.pathDisplay}`, completedFiles, totalFiles: files.length, bytesDone: finishedBytes, totalBytes })
    }
    emitProgress({ type: 'success', message: 'Download complete.', completedFiles, totalFiles: files.length, bytesDone: totalBytes, totalBytes })
  } catch (error) {
    emitProgress({ type: 'error', message: error instanceof Error ? error.message : 'Download failed.' })
    throw error
  } finally {
    transferRunning = false
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'Dropbox Download Manager',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false }
  })
  mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL ?? `file://${join(__dirname, '../renderer/index.html')}`)
}

app.whenReady().then(() => {
  ipcMain.handle('settings:read', async () => {
    const settings = await loadSettings()
    const config = await readConfig().catch(() => null)
    return { configPath: configPath(), configured: Boolean(config && config.dropbox.appKey !== defaultConfig.dropbox.appKey), authenticated: Boolean(settings.tokens?.access_token && settings.tokenAppKey === config?.dropbox.appKey) }
  })
  ipcMain.handle('auth:begin', beginAuthentication)
  ipcMain.handle('auth:finish', async (_event, code: string) => { await finishAuthentication(code); return { authenticated: true } })
  ipcMain.handle('dropbox:list-folder', async (_event, path: string) => listFolder(path))
  ipcMain.handle('dropbox:folder-size', async (_event, path: string) => getFolderSize(path))
  ipcMain.handle('dropbox:folder-actions', () => new Promise<'show-folder-size' | 'refresh' | null>((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Show folder size', click: () => resolve('show-folder-size') },
      { label: 'Refresh', click: () => resolve('refresh') }
    ])
    menu.popup({ window: mainWindow!, callback: () => resolve(null) })
  }))
  ipcMain.handle('dialog:select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? '' : result.filePaths[0]
  })
  ipcMain.handle('download:start', async (_event, items: SelectedItem[], directory: string) => startDownload(items, directory))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
