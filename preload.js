const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('api', {
  chooseDirectory: async () => {
    const p = await ipcRenderer.invoke('choose-dir');
    return p || null;
  },
  readDirectory: async (dirPath) => {
    const res = await ipcRenderer.invoke('read-dir', dirPath);
    return res;
  },
  watchDirectory: async (dirPath) => {
    return await ipcRenderer.invoke('watch-dir', dirPath);
  },
  unwatchDirectory: async (dirPath) => {
    return await ipcRenderer.invoke('unwatch-dir', dirPath);
  },
  onDirChanged: (cb) => {
    ipcRenderer.on('dir-changed', (ev, info) => cb(info));
  },
  getFileUrl: (filePath) => {
    try { return pathToFileURL(filePath).href; } catch (e) { return 'file://' + filePath; }
  },
  // Auto-updater API
  checkForUpdates: async () => {
    return await ipcRenderer.invoke('check-for-updates');
  },
  downloadUpdate: async () => {
    return await ipcRenderer.invoke('download-update');
  },
  installUpdate: async () => {
    return await ipcRenderer.invoke('install-update');
  },
  onUpdateChecking: (cb) => {
    ipcRenderer.on('update-checking', () => cb());
  },
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-available', (ev, info) => cb(info));
  },
  onUpdateNotAvailable: (cb) => {
    ipcRenderer.on('update-not-available', (ev, info) => cb(info));
  },
  onUpdateError: (cb) => {
    ipcRenderer.on('update-error', (ev, err) => cb(err));
  },
  onUpdateDownloadProgress: (cb) => {
    ipcRenderer.on('update-download-progress', (ev, progress) => cb(progress));
  },
  onUpdateDownloaded: (cb) => {
    ipcRenderer.on('update-downloaded', (ev, info) => cb(info));
  }
});