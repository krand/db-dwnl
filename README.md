# Dropbox Download Manager

A small Electron desktop app for selecting Dropbox files or folders and downloading them through a resilient local transfer queue.

## Setup

1. Create a Dropbox API app in the [Dropbox App Console](https://www.dropbox.com/developers/apps), then grant it the `files.metadata.read` and `files.content.read` scopes. For full-account browsing, choose **Full Dropbox** access; choose **App folder** if that restricted scope is sufficient.
2. Set `dropbox.appKey` in `app.config.json` to your app key. The file is pre-created from `app.config.example.json` and ignored by Git.
3. Install and start the application:

   ```bash
   npm install
   npm run dev
   ```

Select **Authenticate with Dropbox**. The app opens the browser, and Dropbox shows an authorization code after approval; paste that code into the app. This matches the CLI-style OAuth flow, with PKCE and an offline refresh token. The app key is public; do not enter an app secret.

`app.config.json` contains all app-specific OAuth and transfer properties. In a packaged app, place this file in the application's user-data directory, or set `DB_DWNL_CONFIG` to its absolute path before launching.

## Packaging

The project uses electron-builder for installers. Build for the current platform with:

```bash
npm run dist
```

Or build a specific target:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Artifacts are written to `release/`: DMG and ZIP on macOS, an NSIS setup executable on Windows, and AppImage/DEB packages on Linux. Build each platform on that platform when possible, especially for signed releases.

After installing, copy `app.config.example.json` to the user-data config path reported by the app and set `dropbox.appKey`. Do not package access tokens or `settings.bin`; they are created per user after authentication.

## Download behaviour

- The Dropbox tree is loaded on demand.
- File and folder selections are expanded into a transfer queue.
- The official Dropbox SDK streams downloads to `.part` files, uses ranged parallel requests for large files (including 10 GB files), retries recoverable failures within a run, and validates completed content before the file is committed. A new run removes any leftover `.part` file and restarts that incomplete file cleanly.
- Before each download, the app checks the destination volume for enough free space for a fresh copy.
- Existing successful files are skipped when their size matches Dropbox metadata.

Credentials are stored using Electron's operating-system-backed `safeStorage` facility where the platform provides it.
