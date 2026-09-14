const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  onModel: (cb) => ipcRenderer.on('model', (_e, m) => cb(m)),
  onCommand: (cb) => ipcRenderer.on('command', (_e, c) => cb(c)),
  setIgnore: (v) => ipcRenderer.send('set-ignore', v),
  contextMenu: () => ipcRenderer.send('context-menu'),
  editMenu: () => ipcRenderer.send('edit-menu'),
  saveState: (s) => ipcRenderer.send('save-state', s),
  modelReady: () => ipcRenderer.send('model-ready'),
  modelFailed: () => ipcRenderer.send('model-failed'),
  requestModel: () => ipcRenderer.send('request-model'),
  log: (m) => ipcRenderer.send('log', m),
  saveSettings: (patch) => ipcRenderer.send('save-settings', patch),
  pickModel: () => ipcRenderer.send('pick-model'),
  defaultModel: () => ipcRenderer.send('default-model'),
  quit: () => ipcRenderer.send('quit'),
  resetSettings: () => ipcRenderer.send('reset-settings'),
  openSoundsFolder: () => ipcRenderer.send('open-sounds-folder'),
  rescanSounds: () => ipcRenderer.send('rescan-sounds'),
});
