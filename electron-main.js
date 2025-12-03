const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const chokidar = require('chokidar');

let mainWindow;
const watchers = new Map();

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // mainWindow.webContents.openDevTools();
}

async function configureProxyFromEnv() {
  // priority: APP_PROXY -> HTTPS_PROXY -> HTTP_PROXY
  const raw = process.env.APP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  if (!raw) {
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[proxy] no proxy env set -> direct');
    return { mode: 'direct' };
  }

  // Normalize common forms (if user set without scheme)
  let proxy = raw;
  if (!/^([a-z]+:)?\/\//i.test(proxy)) {
    // assume http if not provided
    proxy = 'http://' + proxy;
  }

  // For Chromium's proxyRules, we can pass a single proxyRules string.
  // If proxy is an HTTP proxy like http://127.0.0.1:7890, set both http and https.
  // If it's socks5 (socks5://...), use that directly.
  let proxyRules = proxy;
  if (/^http:\/\//i.test(proxy) || /^https:\/\//i.test(proxy)) {
    // remove scheme for proxyRules form
    const url = new URL(proxy);
    proxyRules = `http=${url.hostname}:${url.port};https=${url.hostname}:${url.port}`;
  } else {
    proxyRules = proxy; // e.g. socks5://127.0.0.1:7890
  }

  try {
    await session.defaultSession.setProxy({ proxyRules });
    console.log('[proxy] set proxyRules =', proxyRules);
    // Try to resolve proxy for a test URL to verify (non-blocking)
    const resolve = await session.defaultSession.resolveProxy('https://github.com/');
    console.log('[proxy] resolveProxy =>', resolve);
    return { mode: 'proxy', proxyRules, resolve };
  } catch (err) {
    console.warn('[proxy] failed to set proxy', err);
    await session.defaultSession.setProxy({ mode: 'direct' });
    return { mode: 'direct', error: String(err) };
  }
}

// Helper: recursive walk for media files
async function walkDirCollect(dir) {
  const results = [];
  async function walk(p) {
    const entries = await fs.readdir(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith('.mp3') || lower.endsWith('.m4a')) {
          const st = await fs.stat(full);
          results.push({ name: e.name, path: full, size: st.size });
        }
      }
    }
  }
  await walk(dir);
  results.sort((a,b)=> a.name.localeCompare(b.name));
  return results;
}

// IPC handlers (choose-dir / read-dir / watch-dir / unwatch-dir)
ipcMain.handle('choose-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
  return res.filePaths[0];
});
ipcMain.handle('read-dir', async (event, dirPath) => {
  try {
    const files = await walkDirCollect(dirPath);
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
ipcMain.handle('watch-dir', (event, dirPath) => {
  if (!dirPath) return { ok: false, error: 'no path' };
  if (watchers.has(dirPath)) return { ok: true };
  const watcher = chokidar.watch(dirPath, { persistent: true, ignoreInitial: true, depth: 10 });
  watcher.on('all', (eventType, changedPath) => {
    mainWindow.webContents.send('dir-changed', { eventType, changedPath, dirPath });
  });
  watchers.set(dirPath, watcher);
  return { ok: true };
});
ipcMain.handle('unwatch-dir', (event, dirPath) => {
  const w = watchers.get(dirPath);
  if (w) { w.close(); watchers.delete(dirPath); }
  return { ok: true };
});

// App lifecycle
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.whenReady().then(async () => {
  // Configure proxy before creating the window so network uses it immediately.
  const proxyInfo = await configureProxyFromEnv();
  console.log('[app] proxyInfo:', proxyInfo);

  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});