'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, shell, Menu } = require('electron');
const { Backend } = require('./backend');

protocol.registerSchemesAsPrivileged([
  { scheme: 'appicon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let backend;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: 'Home Screen Organizer',
    backgroundColor: '#f3f4f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** The app used to be called iPad Organizer; carry its backups over to the new folder name. */
function moveOldBackups(oldDir, newDir) {
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
  } catch (e) {
    console.warn('could not move old backups', e && e.message);
  }
}

const ROUTES = {
  devices: () => backend.devices(),
  demo: (body) => backend.setDemo(body && body.on),
  load: (body) => backend.load(body || {}),
  apply: (body) => backend.apply(body),
  backups: () => backend.backups(),
  restore: (body) => backend.restore(body),
  showBackups: () => { shell.openPath(backend.backupDir); return { ok: true }; },
};

app.whenReady().then(() => {
  const backupDir = path.join(app.getPath('documents'), 'Home Screen Organizer Backups');
  moveOldBackups(path.join(app.getPath('documents'), 'iPad Organizer Backups'), backupDir);
  backend = new Backend({
    backupDir,
    iconDir: path.join(app.getPath('userData'), 'icon-cache'),
    demo: process.argv.includes('--demo'),
  });

  ipcMain.handle('api', async (_e, route, body) => {
    const fn = ROUTES[route];
    if (!fn) return { error: `Unknown action ${route}` };
    try {
      return { result: await fn(body) };
    } catch (e) {
      const { friendly } = require('./device');
      console.error(e);
      return { error: friendly(e, backend.info ? backend.info.profile.label : undefined) };
    }
  });

  protocol.handle('appicon', async (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
    const r = await backend.icon(id).catch(() => null);
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body, { headers: { 'Content-Type': r.type, 'Cache-Control': 'max-age=86400' } });
  });

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
