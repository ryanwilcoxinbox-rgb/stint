'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  setHotkeys: (settings) => ipcRenderer.invoke('hotkey:set', settings),
  idleTime: () => ipcRenderer.invoke('system:idle'),
  exportCsv: (data) => ipcRenderer.invoke('export:csv', data),
  exportJson: (data) => ipcRenderer.invoke('export:json', data),
  importJson: () => ipcRenderer.invoke('import:json'),
  getLoginItem: () => ipcRenderer.invoke('login:get'),
  setLoginItem: (enabled) => ipcRenderer.invoke('login:set', enabled),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  backupInfo: () => ipcRenderer.invoke('backup:info'),
  openBackups: () => ipcRenderer.invoke('backup:reveal'),
  chooseBackupDir: () => ipcRenderer.invoke('backup:choose-dir'),

  // Main -> renderer signals (from global hotkey or tray menu).
  onToggle: (cb) => ipcRenderer.on('hotkey:toggle', () => cb()),
  onStop: (cb) => ipcRenderer.on('hotkey:stop', () => cb()),
  onNavigate: (cb) => ipcRenderer.on('navigate:track', () => cb()),

  // Floating "still tracking" pill.
  onMiniUpdate: (cb) => ipcRenderer.on('mini:update', (_e, state) => cb(state)),
  miniShow: () => ipcRenderer.send('mini:show'),
});
