# Stint

A dead-simple desktop time tracker for client work. Pick a client, hit start, pause/stop,
and add a note about what you did. Built to avoid the clutter of most time-tracking apps.

## What it does

Four tabs:

- **Track** — pick a client, run the timer (Start / Pause / Stop, big display), and see a
  Today / This-week stat strip plus today's live per-client totals.
- **History** — your full session archive, browsable by **Day / Week / Month**, with a
  summary dashboard (per-client bars, hours, earnings, period total), search, manual
  **+ Add**, and full edit of any session (client, date, start/end, note).
- **Clients** — name, address, free-text details, **hourly rate**, and a colour.
- **Data** — export, backups, and settings (below).

Plus:

- **Global hotkey** — start/pause from *any* app (default `Ctrl+Shift+Space`), even when
  the window isn't focused. `Ctrl+Shift+T` shows/hides the window and lands on Track.
- **System tray** — closing the window hides it to the tray; the app keeps running so the
  hotkey still works. Tray menu: Show/Hide, Start/Pause, Stop, Quit.
- **Note on Stop** — each finished chunk of work gets a note. Notes stay editable.
- **Earnings & billing** — set an hourly rate per client; the History summary and CSV
  compute amounts. Optional rounding (6/15/30 min, nearest or up). Currency configurable
  (defaults to €).
- **Idle detection** — if your PC goes idle past a threshold (default 10 min) while a
  timer runs, you're prompted to discard that idle time when you return.
- **Window position** is remembered between launches.
- **Launch at login** — optional toggle (Data → Startup) that auto-starts the app hidden
  in the tray when you log in.
- **Export & backup** — CSV for invoicing, JSON for full backup/restore, plus automatic
  daily backups (see below).

## Requirements

- Windows
- [Node.js](https://nodejs.org) 18+ (already installed: v20)

## Run it (development)

```powershell
npm install
npm start
```

## Launch without a terminal (recommended)

You don't need to build an installer. Two launchers are already set up:

- **`Stint` shortcut on your Desktop** — double-click it. Right-click →
  *Pin to taskbar* / *Pin to Start* to keep it handy. To launch at login, press
  `Win+R`, type `shell:startup`, and drop a copy of the shortcut in that folder.
- **`Launch Stint.cmd`** in this folder — same thing, as a fallback.

Both run the app directly via the bundled Electron binary — no console window, no admin.

## Build a real installer (optional, has prerequisites)

```powershell
npm run dist
```

This needs two one-time fixes on Windows, otherwise it fails:

1. **Symlink privilege** — turn on *Settings → Privacy & security → For developers →
   Developer Mode* (or run the terminal as Administrator). Without it `electron-builder`
   can't extract its code-signing tools.
2. **PowerShell script policy** — if you see "npm.ps1 cannot be loaded", run once:
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Or just use `npm.cmd run dist`.

For a personal tool, the Desktop shortcut above is simpler and does the same job.

## Shipping an update (auto-update)

Installed copies keep themselves up to date from GitHub Releases. The app checks on
launch and every 6 hours, downloads a newer version in the background, and installs it
the next time Stint quits — so an update never interrupts a running timer.

To ship a new version:

1. **Bump `version` in `package.json`.** Auto-update compares this number; an unchanged
   version ships nothing.
2. **Provide a GitHub token** with `repo` scope, once per terminal:
   `$env:GH_TOKEN = gh auth token` (or paste a token you created manually).
3. **`npm run release`**

That builds, creates the GitHub release, and uploads the installer alongside
`latest.yml` — the feed that installed copies read.

The release goes **live immediately** (`"releaseType": "release"` in the publish config).
electron-builder's own default is `draft`, which uploads everything but leaves the
release invisible to the updater — the build reports success while shipping nothing to
anyone. If you ever want a look before it goes out, drop that line and publish the draft
by hand afterwards (`gh release edit v<version> --draft=false`).

Two constraints worth remembering:

- Only the **installer** build (`Stint Setup x.y.z.exe`) can auto-update. The portable
  `.exe` never will; it has nowhere to install to.
- The repo must stay **public**. Release assets on a private repo need authentication,
  which would mean shipping a GitHub token inside the app.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` (global) | Start / pause the active client's timer from anywhere |
| `Ctrl+Shift+T` (global) | Show / hide the window |
| `Space` (in app) | Start / pause |
| `S` (in app) | Stop and add a note |
| `1`–`9` (in app) | Pick the Nth client |

Global hotkeys are configurable on the **Data** tab.

## Where is my data? (resilience)

- **Live data** auto-saves to `timing-data.json` in Windows' app-data folder
  (`%APPDATA%\client-time-tracker\`). Writes are atomic (temp file + rename) so a crash
  mid-save can't corrupt it. **Note:** this folder is *not* in OneDrive, so it is not
  synced on its own — that's why automatic backups exist.
- **Automatic backups** — a dated snapshot (`backups/timing-backup-YYYY-MM-DD.json`) is
  written into the chosen backup folder on launch, every 12 hours, and on quit. One file
  per calendar day (the day's file is overwritten with the latest state).
  **Retention is tiered:** every daily snapshot from the last **90 days** is kept, and
  older ones are thinned to **one per month, kept indefinitely**. The 90-day tier is the
  "undo" window — long enough that a problem spotted at invoicing time still has a clean
  snapshot behind it — while the monthly archive keeps long-term history without the
  synced folder growing forever. Manage via **Data → Automatic backups**
  (Back up now / Open backups folder / Choose backup folder).
- **Recovery** — if anything ever breaks or the PC is lost, install the app on the new
  machine, open **Data → Import JSON backup**, and pick the newest file from `backups/`.
  You're back to your last snapshot.
- **Manual export** — **Data → Export CSV** for invoicing; **Save JSON backup** for an
  on-demand full snapshot anywhere you choose.

## Data shape (for a future dashboard)

```jsonc
{
  "clients":  [{ "id", "name", "address", "details", "createdAt" }],
  "sessions": [{ "id", "clientId", "date", "start", "end", "durationSec", "note" }],
  "timer":    { "activeClientId", "running", "accumulatedSec", "lastStartTs", "sessionStart" },
  "settings": { "globalHotkey", "showHideHotkey" }
}
```

Sessions are a flat, append-only log — straightforward to read for per-client charts and
weekly/monthly rollups later.

## Regenerating the icons

```powershell
node assets/generate-icons.js
```
