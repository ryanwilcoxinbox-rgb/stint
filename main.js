'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, nativeImage, powerMonitor, screen, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Force a stable app name so the dev run (`npm start`) and the packaged/installed
// build share the SAME user-data folder (%APPDATA%\client-time-tracker). Without
// this, the installed app would use a different folder and appear to "lose" data.
app.setName('client-time-tracker');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const DATA_FILE = path.join(app.getPath('userData'), 'timing-data.json');
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const ASSET_DIR = path.join(__dirname, 'assets');
const TRAY_ICON = path.join(ASSET_DIR, 'tray-icon.png');
const TRAY_ICON_ACTIVE = path.join(ASSET_DIR, 'tray-icon-active.png');
const TRAY_ICON_PAUSED = path.join(ASSET_DIR, 'tray-icon-paused.png');
// Backups/exports must land in a writable, OneDrive-synced folder. In dev that's the
// project folder (__dirname); once installed, __dirname is read-only inside the app
// bundle, so fall back to the user's OneDrive root (or Documents).
const BACKUP_DIR = app.isPackaged
  ? path.join(process.env.OneDrive || process.env.OneDriveConsumer || app.getPath('documents'), 'Client Time Tracker')
  : __dirname;
const AUTO_BACKUP_DIR = path.join(BACKUP_DIR, 'backups');
const BACKUP_KEEP = 14; // daily snapshots to retain
let lastBackupTime = null;

const DEFAULT_DATA = {
  clients: [],
  sessions: [],
  timer: { activeClientId: null, running: false, accumulatedSec: 0, lastStartTs: null, sessionStart: null },
  settings: {
    globalHotkey: '',
    showHideHotkey: 'CommandOrControl+Alt+T',
    currencySymbol: '€',
    roundIncrementMin: 0,
    roundUp: false,
    idleThresholdMin: 10,
    hoursPerDay: 8,
    launchAtLogin: false,
  },
};

let mainWindow = null;
let miniWindow = null; // small always-on-top "still tracking" pill, shown while hidden
let tray = null;
let isQuitting = false;
let cachedData = null; // last data the renderer saved; used for tray menu state

// ---------------------------------------------------------------------------
// Data file helpers
// ---------------------------------------------------------------------------
function readDataSync() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_DATA,
      ...parsed,
      timer: { ...DEFAULT_DATA.timer, ...(parsed.timer || {}) },
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

async function writeData(data) {
  cachedData = data;
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE); // atomic-ish write to avoid corruption
}

// ---------------------------------------------------------------------------
// Automatic backups — daily JSON snapshot into the OneDrive-synced project
// folder, keeping the most recent BACKUP_KEEP days. Returns the file path.
// ---------------------------------------------------------------------------
const BACKUP_RE = /^timing-backup-\d{4}-\d{2}-\d{2}\.json$/;

function autoBackup() {
  try {
    if (!cachedData) return null;
    fs.mkdirSync(AUTO_BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const file = path.join(AUTO_BACKUP_DIR, `timing-backup-${day}.json`);
    fs.writeFileSync(file, JSON.stringify(cachedData, null, 2), 'utf8'); // overwrites same-day = latest
    lastBackupTime = d.toISOString();

    // Rotate: keep the newest BACKUP_KEEP daily files.
    const files = fs.readdirSync(AUTO_BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(AUTO_BACKUP_DIR, old)); } catch (_) {}
    }
    return file;
  } catch (err) {
    console.error('autoBackup failed:', err && err.message);
    return null;
  }
}

function backupInfo() {
  let count = 0;
  try { count = fs.readdirSync(AUTO_BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).length; } catch (_) {}
  return { dir: AUTO_BACKUP_DIR, lastBackup: lastBackupTime, count };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(data) {
  const clientsById = new Map((data.clients || []).map((c) => [c.id, c]));
  const settings = data.settings || {};
  const inc = Number(settings.roundIncrementMin || 0) * 60;
  const roundUp = !!settings.roundUp;
  const sym = settings.currencySymbol || '€';
  const hpd = Math.max(1, Number(settings.hoursPerDay || 8));
  const roundSec = (sec) => (inc ? (roundUp ? Math.ceil(sec / inc) : Math.round(sec / inc)) * inc : sec);

  const header = ['Date', 'Client', 'Address', 'Start', 'End', 'Hours', 'Day Rate', 'Amount', 'Note'];
  const rows = [header.join(',')];
  const sessions = [...(data.sessions || [])].sort((a, b) =>
    String(a.start || '').localeCompare(String(b.start || ''))
  );
  for (const s of sessions) {
    const client = clientsById.get(s.clientId) || {};
    const billedSec = roundSec(Number(s.durationSec || 0));
    const hours = (billedSec / 3600).toFixed(2);
    let hourlyRate = null;
    if (client.dayRate != null && client.dayRate !== '' && !isNaN(Number(client.dayRate))) {
      hourlyRate = Number(client.dayRate) / hpd;
    } else if (client.rate != null && client.rate !== '' && !isNaN(Number(client.rate))) {
      hourlyRate = Number(client.rate);
    }
    const dayRateVal = hourlyRate != null ? hourlyRate * hpd : null;
    const rate = dayRateVal != null ? sym + dayRateVal.toFixed(2) : '';
    const amount = hourlyRate != null ? sym + ((billedSec / 3600) * hourlyRate).toFixed(2) : '';
    const fmt = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      return isNaN(d) ? '' : d.toLocaleString();
    };
    rows.push([
      csvEscape(s.date || ''),
      csvEscape(client.name || '(deleted client)'),
      csvEscape(client.address || ''),
      csvEscape(fmt(s.start)),
      csvEscape(fmt(s.end)),
      csvEscape(hours),
      csvEscape(rate),
      csvEscape(amount),
      csvEscape(s.note || ''),
    ].join(','));
  }
  return rows.join('\r\n');
}

function timestampSlug() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Window state memory
// ---------------------------------------------------------------------------
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    // Only restore if the saved rect still intersects a connected display.
    const area = screen.getDisplayMatching(s).workArea;
    const visible = s.x + s.width > area.x && s.x < area.x + area.width &&
                    s.y + s.height > area.y && s.y < area.y + area.height;
    if (visible) return s;
  } catch (_) { /* no saved state */ }
  return null;
}

let saveStateTimer = null;
function saveWindowState() {
  if (!mainWindow || mainWindow.isMinimized()) return;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    try {
      const b = mainWindow.getBounds();
      fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(b));
    } catch (_) { /* ignore */ }
  }, 400);
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------
function createWindow() {
  const saved = loadWindowState();
  const startHidden = process.argv.includes('--hidden'); // set when launched at login
  mainWindow = new BrowserWindow({
    width: saved ? saved.width : 460,
    height: saved ? saved.height : 720,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 380,
    minHeight: 560,
    title: 'Stint',
    icon: TRAY_ICON,
    show: !startHidden, // boot straight to the tray when auto-started at login
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  // Closing the window hides to tray instead of quitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      saveWindowState();
      mainWindow.hide();
      updateMini();
    }
  });
  mainWindow.on('hide', updateMini);
  mainWindow.on('show', updateMini);
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  // On Windows a freshly shown window often isn't given true foreground focus, so the
  // first click/keystroke gets swallowed. Briefly toggling alwaysOnTop forces it to the
  // foreground so inputs are immediately typable.
  if (process.platform === 'win32') {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
  }
  mainWindow.focus();
  // Always land on the Track tab when the window is summoned (e.g. Ctrl+Alt+T).
  mainWindow.webContents.send('navigate:track');
  updateMini();
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ---------------------------------------------------------------------------
// Floating "still tracking" pill — a small always-on-top window shown only when
// the timer is running AND the main window is hidden, so tracking is always
// visible even if the tray icon is tucked away in the Windows overflow.
// ---------------------------------------------------------------------------
const MINI_W = 210, MINI_H = 52;
const MINI_STATE_FILE = path.join(app.getPath('userData'), 'mini-state.json');

// Remember where the user dragged the pill (validated against connected displays).
function loadMiniPos() {
  try {
    const p = JSON.parse(fs.readFileSync(MINI_STATE_FILE, 'utf8'));
    const area = screen.getDisplayMatching({ x: p.x, y: p.y, width: MINI_W, height: MINI_H }).workArea;
    const onScreen = p.x + MINI_W > area.x && p.x < area.x + area.width &&
                     p.y + MINI_H > area.y && p.y < area.y + area.height;
    if (onScreen) return p;
  } catch (_) { /* none saved */ }
  return null;
}
let miniSaveTimer = null;
function saveMiniPos() {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  clearTimeout(miniSaveTimer);
  miniSaveTimer = setTimeout(() => {
    try {
      const b = miniWindow.getBounds();
      fs.writeFileSync(MINI_STATE_FILE, JSON.stringify({ x: b.x, y: b.y }));
    } catch (_) { /* ignore */ }
  }, 400);
}

function createMiniWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = loadMiniPos();
  miniWindow = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    x: saved ? saved.x : wa.x + wa.width - MINI_W - 18,
    y: saved ? saved.y : wa.y + wa.height - MINI_H - 14, // default bottom-right, above tray
    frame: false,
    // A non-transparent window. Transparent + frameless + always-on-top is
    // notoriously unreliable on Windows (the window can silently stop painting
    // after a Windows/GPU update), which is what made the pill "disappear".
    transparent: false,
    backgroundColor: '#0f1422',
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true, // needs focus to be draggable via the OS
    show: false,
    icon: TRAY_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  miniWindow.setAlwaysOnTop(true, 'screen-saver');
  miniWindow.on('move', saveMiniPos); // remember where the user drags it
  miniWindow.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  // Once the pill's page is actually ready, push current state and re-evaluate
  // whether it should be shown. Without this, an early mini:update (e.g. when
  // booting hidden with a timer already running) is sent before the renderer is
  // listening and gets dropped, leaving the pill blank or never appearing.
  miniWindow.webContents.once('did-finish-load', () => updateMini());
}

function miniState() {
  const t = (cachedData && cachedData.timer) || {};
  const client = (cachedData && cachedData.clients || []).find((c) => c.id === t.activeClientId);
  return {
    running: !!t.running,
    accumulatedSec: t.accumulatedSec || 0,
    lastStartTs: t.lastStartTs || null,
    name: client ? client.name : 'No client',
    color: client && client.color ? client.color : '#34d399',
  };
}

function updateMini() {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  const running = cachedData && cachedData.timer && cachedData.timer.running;
  const mainHidden = !mainWindow || !mainWindow.isVisible();
  const shouldShow = running && mainHidden;
  if (shouldShow) {
    miniWindow.webContents.send('mini:update', miniState());
    if (!miniWindow.isVisible()) miniWindow.showInactive();
  } else if (miniWindow.isVisible()) {
    miniWindow.hide();
  }
}

function trayTooltip() {
  if (!cachedData) return 'Stint';
  const t = cachedData.timer || {};
  const client = (cachedData.clients || []).find((c) => c.id === t.activeClientId);
  const name = client ? client.name : 'No client';
  return `Stint — ${t.running ? 'Running' : 'Paused'} (${name})`;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const t = (cachedData && cachedData.timer) || {};
  const running = !!t.running;
  // A session is "paused" when it's open (has elapsed time or a start) but not
  // counting. Swap the tray icon across all three states so the timer's state is
  // visible even with the window hidden: green = running, amber = paused, indigo
  // = stopped.
  const paused = !running && ((t.accumulatedSec || 0) > 0 || !!t.sessionStart);
  const iconPath = running ? TRAY_ICON_ACTIVE : paused ? TRAY_ICON_PAUSED : TRAY_ICON;
  const img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) tray.setImage(img);
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => toggleWindow() },
    { type: 'separator' },
    {
      label: running ? 'Pause timer' : 'Start timer',
      click: () => mainWindow && mainWindow.webContents.send('hotkey:toggle'),
    },
    {
      label: 'Stop timer',
      click: () => mainWindow && mainWindow.webContents.send('hotkey:stop'),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(trayTooltip());
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_ICON);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.on('click', () => toggleWindow());
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------
function registerHotkeys(settings) {
  globalShortcut.unregisterAll();
  const results = { toggle: false, showHide: false };
  if (settings.globalHotkey) {
    results.toggle = globalShortcut.register(settings.globalHotkey, () => {
      if (mainWindow) mainWindow.webContents.send('hotkey:toggle');
    });
  }
  if (settings.showHideHotkey) {
    results.showHide = globalShortcut.register(settings.showHideHotkey, () => toggleWindow());
  }
  return results;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('data:load', async () => {
  cachedData = readDataSync();
  return cachedData;
});

ipcMain.handle('data:save', async (_e, data) => {
  await writeData(data);
  rebuildTrayMenu();
  updateMini();
  return true;
});

// Clicking the floating pill restores the main window.
ipcMain.on('mini:show', () => showWindow());

ipcMain.handle('hotkey:set', async (_e, settings) => {
  return registerHotkeys(settings);
});

// Seconds since the user last touched mouse/keyboard (system-wide).
ipcMain.handle('system:idle', () => powerMonitor.getSystemIdleTime());

ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('login:set', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: enabled ? ['--hidden'] : [] });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('backup:now', () => { const f = autoBackup(); return { ok: !!f, file: f, info: backupInfo() }; });
ipcMain.handle('backup:info', () => backupInfo());
ipcMain.handle('backup:reveal', async () => {
  try { fs.mkdirSync(AUTO_BACKUP_DIR, { recursive: true }); } catch (_) {}
  await shell.openPath(AUTO_BACKUP_DIR);
  return true;
});

ipcMain.handle('export:csv', async (_e, data) => {
  const defaultPath = path.join(BACKUP_DIR, `time-export_${timestampSlug()}.csv`);
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export sessions to CSV',
    defaultPath,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  await fsp.writeFile(res.filePath, '﻿' + buildCsv(data), 'utf8'); // BOM for Excel
  return { ok: true, filePath: res.filePath };
});

ipcMain.handle('export:json', async (_e, data) => {
  const defaultPath = path.join(BACKUP_DIR, `time-backup_${timestampSlug()}.json`);
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save JSON backup',
    defaultPath,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  await fsp.writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, filePath: res.filePath };
});

ipcMain.handle('import:json', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import JSON backup',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false };
  try {
    const raw = await fsp.readFile(res.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);
    const data = {
      ...DEFAULT_DATA,
      ...parsed,
      timer: { ...DEFAULT_DATA.timer, ...(parsed.timer || {}) },
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
    };
    await writeData(data);
    rebuildTrayMenu();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    cachedData = readDataSync();
    createWindow();
    createMiniWindow();
    createTray();
    registerHotkeys(cachedData.settings || DEFAULT_DATA.settings);
    updateMini(); // in case a timer was already running and we booted hidden

    autoBackup();                                    // snapshot on launch
    setInterval(autoBackup, 12 * 60 * 60 * 1000);    // and every 12 hours

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => { isQuitting = true; autoBackup(); }); // snapshot on quit
  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Keep running in the tray when all windows are closed (do not quit on Windows).
  app.on('window-all-closed', () => {});
}
