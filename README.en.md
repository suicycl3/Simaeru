# Simaeru

[日本語](README.md) | [English](README.en.md) | [简体中文](README.zh-CN.md)

A Windows desktop app that brings the titles you bought on **DMM / FANZA and DLsite** into one place,
so you can browse, search, download, view and manage installs.

> This is an unofficial app and is not affiliated with DMM or DLsite. Follow each site's terms of service and use it to manage titles you purchased yourself.

## Features

- **Library** — Sync your purchase history and browse it with covers (filter by category, type, brand, tags, people/series, regular expressions, favorites; sort by last used)
- **Downloads** — Download inside the app, resume interrupted downloads, download in bulk (including DLsite multipart downloads), limit bandwidth, and see counts, sizes, speed and time left
- **Viewing and playback** — Open manga, CG, voice and video titles **straight from the zip**: an image viewer (two-page spread, zoom, sharpening), a voice player with scripts and subtitles side by side, PDF and video
- **File management** — Choose per type whether to keep titles compressed or extract them. Convert WAV to FLAC, keep only the MP3 versions, remove PDFs that duplicate the images, delete to the Recycle Bin, move the download folder, and import files you already have
- **Games** — Extract, detect whether an installer is needed, link a launch file and launch. Launch DMM GAMES PLAYER-only games, and find link candidates automatically
- **Read and play in the browser** — Open the sites' web viewers in an in-app window, staying signed in
- **Languages** — 日本語 / English / 简体中文

## Requirements

| Item | Details |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| To build | Node.js 20 or later |
| External tools (optional) | 7-Zip, ffmpeg, NeeView. **Not bundled.** Installed copies are used if present; otherwise they can be downloaded from the official GitHub releases in Settings (checksums are verified) |

## Getting started

```bash
npm install
```

| How to start | Details |
|---|---|
| `Simaeru.bat` | Normal start (uses the existing build, building first if there is none) |
| `Simaeru.bat build` | After updating the source: rebuild, then start |
| `Simaeru.bat dev` | Development mode |

1. Open ⚙ at the top of the sidebar → Accounts, and log in to the sites you use (you log in on the site's own page).
2. Press "Sync purchases" in the toolbar to import your titles.
3. Select a title and press "Download in app". When it finishes, open it from "Local files".

The detailed feature documentation in [docs/](docs/README.md) is written in Japanese.

## Principles

- **No DRM removal.** Titles with DRM are only stored and handed to the official viewer.
- **No plain-text passwords.** Saved IDs and passwords are encrypted with Windows DPAPI, and nothing is saved if encryption is unavailable. The app never presses the login button for you.
- **Your data stays on this PC.** Nothing is sent to the author or any third-party server.
- **Deleted files go to the Recycle Bin.** Rebuilt files are verified before they replace the originals.

## Data locations

| Location | Contents |
|---|---|
| `%APPDATA%\simaeru\library.db` | Purchase history, local file records, download history and settings (SQLite) |
| `%APPDATA%\simaeru\credentials.dpapi` | Saved IDs and passwords (encrypted) |
| `%APPDATA%\simaeru\covers\` | Cover image cache |
| `%APPDATA%\simaeru\tools\` | 7-Zip / ffmpeg / NeeView installed from Settings |
| `%APPDATA%\simaeru\Partitions\` | Login sessions for each site |
| Download folder | `Documents\Simaeru` by default |

## Development

```bash
npm run typecheck
node tools/test-content-rules.mjs
node tools/i18n-keys.cjs --check
npx electron tools/test-library-local.js
npx electron tools/test-postprocess.js
```

See [docs/development.md](docs/development.md) (Japanese) for the project layout, tests and how to add translations.

## License

- The app itself: [MIT License](LICENSE).
- Third-party software and external tools: [THIRD_PARTY_NOTICES.en.md](THIRD_PARTY_NOTICES.en.md) (also shown in Settings → About).
