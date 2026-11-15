'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, shell, Menu, safeStorage } = require('electron');
const { Backend } = require('./backend');
const { License, LicenseError } = require('./license');
const { ErrorLog, issueUrl } = require('./support');
const { Updater } = require('./updater');
const { AI } = require('./ai');
const { appStoreGenres, categorize } = require('./categorize');
const { demoGenres } = require('./demo');

// Bump when the Terms of Service change, so everyone is asked to agree to the new version.
const TERMS_VERSION = 2;

protocol.registerSchemesAsPrivileged([
  { scheme: 'appicon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let backend;
let license;
let win;
let errorLog;
let termsFile;
let updater;
let ai;

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    title: 'Arrange',
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

/** The app used to be called Home Screen Organizer, and before that iPad Organizer; carry their backups over. */
function moveOldBackups(oldDirs, newDir) {
  for (const oldDir of oldDirs) {
    try {
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
    } catch (e) {
      console.warn('could not move old backups', e && e.message);
    }
  }
}

const ROUTES = {
  devices: () => backend.devices(),
  demo: (body) => backend.setDemo(body && body.on),
  load: (body) => backend.load(body || {}),
  apply: async (body) => {
    // The sample devices are free to try; a real device needs a license.
    if (!backend.demo && !(await license.status()).licensed) {
      return { needsLicense: true };
    }
    return backend.apply(body);
  },
  backups: () => backend.backups(),
  restore: (body) => backend.restore(body),
  showBackups: () => { shell.openPath(backend.backupDir); return { ok: true }; },
  license: (body) => license.status(body || {}),
  activate: (body) => license.activate(body && body.key),
  deactivate: () => license.deactivate(),
  help: (body) => {
    const kind = body && body.kind;
    if (!['bug', 'feedback', 'errors'].includes(kind)) throw new Error('Unknown help link');
    shell.openExternal(issueUrl(kind, { version: app.getVersion(), device: backend.info, errors: errorLog.recent() }));
    return { ok: true };
  },
  errorCount: () => errorLog.recent().length,
  clearErrors: () => { errorLog.clear(); return { ok: true }; },
  logError: (body) => { errorLog.record({ message: body && body.message, stack: body && body.stack }, 'window'); return { ok: true }; },
  terms: () => {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(termsFile, 'utf8')); } catch {}
    const text = fs.readFileSync(path.join(__dirname, '..', 'TERMS.md'), 'utf8');
    return { accepted: !!saved && saved.version >= TERMS_VERSION, text };
  },
  acceptTerms: () => {
    fs.writeFileSync(termsFile, JSON.stringify({ version: TERMS_VERSION, at: new Date().toISOString() }));
    return { accepted: true };
  },
  quit: () => { app.quit(); return { ok: true }; },
  update: () => updater.state,
  checkUpdates: () => updater.check(),
  installUpdate: () => updater.install(),
  aiSettings: () => ai.settings(),
  aiSave: (body) => ai.save(body || {}),
  aiDetect: () => ai.detect(),
  aiModels: (body) => ai.models(body && body.id),
  aiTest: (body) => ai.test(body && body.id),
  aiActive: () => ai.activeName(),
  categorize: (body) => {
    const apps = ((body && body.apps) || []).filter((a) => a && a.id).map((a) => ({ id: String(a.id), name: String(a.name || a.id) }));
    if (!apps.length) throw new Error('There are no apps to organize.');
    // The sample apps aren't in the App Store, so they bring their own genres.
    const lookup = backend.demo
      ? async () => demoGenres()
      : (ids) => appStoreGenres(ids, { file: path.join(app.getPath('userData'), 'appstore-genres.json'), country: (app.getLocaleCountryCode() || 'us').toLowerCase() });
    // The AI chosen when Suggest was pressed, even if Settings change while the App Store lookup runs.
    const id = body.useAI ? ai.activeId() : null;
    const asker = id ? { ask: (prompt) => ai.ask(prompt, { id }) } : null;
    return categorize(apps, { lookup, ai: asker, size: body.size, notes: body.notes });
  },
};

process.on('uncaughtException', (e) => { console.error(e); if (errorLog) errorLog.record(e, 'main'); });
process.on('unhandledRejection', (e) => { console.error(e); if (errorLog) errorLog.record(e, 'main'); });

app.whenReady().then(() => {
  const docs = app.getPath('documents');
  const backupDir = path.join(docs, 'Arrange Backups');
  moveOldBackups([path.join(docs, 'Home Screen Organizer Backups'), path.join(docs, 'iPad Organizer Backups')], backupDir);
  backend = new Backend({
    backupDir,
    iconDir: path.join(app.getPath('userData'), 'icon-cache'),
    demo: process.argv.includes('--demo'),
  });
  license = new License({ file: path.join(app.getPath('userData'), 'license.json') });
  errorLog = new ErrorLog({ file: path.join(app.getPath('userData'), 'errors.json') });
  termsFile = path.join(app.getPath('userData'), 'terms.json');
  // API keys are encrypted with the system keychain when it's available.
  const crypt = safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => safeStorage.encryptString(s).toString('base64'), decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')) }
    : null;
  ai = new AI({ file: path.join(app.getPath('userData'), 'ai.json'), crypt });
  updater = new Updater((state) => { if (win && !win.isDestroyed()) win.webContents.send('update', state); });

  ipcMain.handle('api', async (_e, route, body) => {
    const fn = ROUTES[route];
    if (!fn) return { error: `Unknown action ${route}` };
    try {
      return { result: await fn(body) };
    } catch (e) {
      if (e instanceof LicenseError) return { error: e.message };
      if (route.startsWith('ai') || route === 'categorize') {
        // Not about the device, so don't reword it as a device problem.
        errorLog.record(e, route);
        const why = e && e.cause && (e.cause.code || e.cause.message);
        if (e && e.name === 'TimeoutError') return { error: 'The AI took too long to answer. Try again, or try a faster model.' };
        return { error: e && e.message === 'fetch failed' ? `Could not reach the AI service${why ? ` (${why})` : ''}. Check the address and your internet connection.` : String((e && e.message) || e) };
      }
      const { friendly } = require('./device');
      console.error(e);
      errorLog.record(e, route);
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
      {
        role: 'appMenu',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => { if (win && !win.isDestroyed()) win.webContents.send('show', 'settings'); } },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'Report a Problem…', click: () => ROUTES.help({ kind: 'bug' }) },
          { label: 'Send Feedback…', click: () => ROUTES.help({ kind: 'feedback' }) },
          { label: 'Send Error Report…', click: () => ROUTES.help({ kind: 'errors' }) },
          { type: 'separator' },
          { label: 'Check for Updates…', click: () => { if (win && !win.isDestroyed()) win.webContents.send('show', 'checkUpdates'); } },
          { label: 'Terms of Service', click: () => { if (win && !win.isDestroyed()) win.webContents.send('show', 'terms'); } },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();
  updater.start();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
