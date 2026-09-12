declare global {
  type DropboxEntry = { id: string; name: string; pathDisplay: string; pathLower: string; kind: 'file' | 'folder'; size?: number }
  type TransferEvent = { type: 'info' | 'success' | 'error'; message: string; completedFiles?: number; totalFiles?: number; bytesDone?: number; totalBytes?: number }
  interface Window {
    dropboxApp: {
      getSettings(): Promise<{ configPath: string; configured: boolean; authenticated: boolean }>
      beginAuthentication(): Promise<string>
      finishAuthentication(code: string): Promise<{ authenticated: boolean }>
      listFolder(path: string): Promise<DropboxEntry[]>
      chooseDirectory(): Promise<string>
      startDownload(items: Array<Pick<DropboxEntry, 'pathDisplay' | 'pathLower' | 'kind' | 'name'>>, directory: string): Promise<void>
      onProgress(callback: (event: TransferEvent) => void): () => void
    }
  }
}
export {}
