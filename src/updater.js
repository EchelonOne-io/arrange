'use strict';
// Updates come from the public EchelonOne-io/arrange-releases repo (set as "publish" in package.json).
// A new version downloads in the background and installs when the app quits, or right away when
// the person clicks "Restart to Update".
const { app } = require('electron');

const CHECK_EVERY_MS = 6 * 3600 * 1000;

class Updater {
  /** `send(state)` tells the window what's happening: {state, version?, percent?, message?}. */
  constructor(send) {
    this.send = send;
    this.state = { state: 'idle' };
    this.enabled = app.isPackaged; // running from source (npm start) has nothing to update
    if (!this.enabled) return;
    const { autoUpdater } = require('electron-updater');
    this.au = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ ...this.state, percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'ready', version: i.version }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'current' }));
    autoUpdater.on('error', (e) => {
      console.warn('update check failed', e && e.message);
      this.set({ state: 'error', message: 'Couldn\'t check for updates. Check your internet connection and try again.' });
    });
  }

  set(state) { this.state = state; this.send(state); }

  start() {
    if (!this.enabled) return;
    const check = () => this.check().catch(() => {});
    setTimeout(check, 10 * 1000);
    setInterval(check, CHECK_EVERY_MS);
  }

  async check() {
    if (!this.enabled) return { state: 'dev' };
    // Don't start over while a download is under way or waiting to install.
    if (this.state.state === 'downloading' || this.state.state === 'ready') return this.state;
    this.set({ state: 'checking' });
    // A failed check also fires 'error', which sets the message to show.
    await this.au.checkForUpdates().catch(() => {});
    return this.state;
  }

  install() {
    if (this.state.state !== 'ready') return { ok: false };
    setImmediate(() => this.au.quitAndInstall());
    return { ok: true };
  }
}

module.exports = { Updater };
