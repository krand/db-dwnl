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

## Download behaviour

- The Dropbox tree is loaded on demand.
- File and folder selections are expanded into a transfer queue.
- The official Dropbox SDK streams downloads to `.part` files, uses ranged parallel requests for large files (including 10 GB files), resumes interrupted transfers, retries recoverable failures, and validates completed content before the file is committed.
- Before each download, the app checks the destination volume for enough free space, accounting for any existing `.part` file.
- Existing successful files are skipped when their size matches Dropbox metadata.

Credentials are stored using Electron's operating-system-backed `safeStorage` facility where the platform provides it.
