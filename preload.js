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
  }
});