import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dropboxApp', {
  getSettings: () => ipcRenderer.invoke('settings:read'),
  beginAuthentication: () => ipcRenderer.invoke('auth:begin'),
  finishAuthentication: (code: string) => ipcRenderer.invoke('auth:finish', code),
  listFolder: (path: string) => ipcRenderer.invoke('dropbox:list-folder', path),
  getFolderSize: (path: string) => ipcRenderer.invoke('dropbox:folder-size', path),
  showFolderActions: () => ipcRenderer.invoke('dropbox:folder-actions'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  startDownload: (items: unknown[], directory: string) => ipcRenderer.invoke('download:start', items, directory),
  onProgress: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: unknown) => callback(message)
    ipcRenderer.on('download:progress', listener)
    return () => ipcRenderer.removeListener('download:progress', listener)
  }
})
