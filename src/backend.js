'use strict';
// App logic independent of Electron, so it can be unit-tested with plain Node.

const fs = require('fs');
const path = require('path');
const bplist = require('./bplist');
const { Layout, allKeys, flattenIds } = require('./layout');
const { demoState, demoIconSVG, demoInstalled } = require('./demo');
const demoLibrary = (list) => list;

class Backend {
  constructor({ backupDir, iconDir, demo = false, device = null }) {
    this.backupDir = backupDir;
    this.iconDir = iconDir;
    this.demo = demo;
    this.deviceMod = device || require('./device');
    this.sb = null;
    this.info = null;
    this.layout = null;
    this.demoCurrent = demoState();
    this.demoInstalled = demoInstalled();
  }

  backup(state, label) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    const who = (this.info && this.info.name ? this.info.name : 'iPad').replace(/[^\w -]/g, '').slice(0, 30);
    const file = path.join(this.backupDir, `${stamp} ${who} (${label}).plist`);
    fs.writeFileSync(file, bplist.build(state));
    return file;
  }

  async devices() {
    if (this.demo) return { demo: true, devices: [{ udid: 'demo', name: 'Sample iPad', ios: '26.1' }] };
    try {
      return { demo: false, devices: await this.deviceMod.listDevices() };
    } catch (e) {
      return { demo: false, devices: [], error: this.deviceMod.friendly(e) };
    }
  }

  setDemo(on) {
    this.demo = !!on;
    if (this.sb) this.sb.close();
    this.sb = null;
    this.layout = null;
    return { demo: this.demo };
  }

  async _connect(udid) {
    if (this.sb && this.sb.udid === udid) return;
    if (this.sb) this.sb.close();
    this.info = await this.deviceMod.deviceInfo(udid);
    this.sb = new this.deviceMod.SpringBoard(udid);
  }

  async _getState() {
    try {
      return await this.sb.getIconState();
    } catch (e) {
      if (e.timeout) throw e;
      this.sb.close(); // one retry on a dropped connection
      return this.sb.getIconState();
    }
  }

  async load({ udid } = {}) {
    let raw;
    if (this.demo) {
      raw = this.demoCurrent;
      this.info = { name: 'Sample iPad', ios: '26.1', udid: 'demo' };
    } else {
      if (!udid) {
        const list = await this.deviceMod.listDevices();
        if (!list.length) throw new Error('No iPad found. Plug it in with a cable and unlock it.');
        udid = list[0].udid;
      }
      await this._connect(udid);
      raw = await this._getState();
    }
    if (!Array.isArray(raw)) throw new Error('The iPad sent a layout this app does not understand.');
    this.backup(raw, 'opened');
    this.layout = new Layout(raw);
    const tree = this.layout.toTree();
    let installed = [];
    try {
      installed = this.demo ? demoLibrary(this.demoInstalled) : await this.deviceMod.installedApps(this.info.udid);
    } catch (e) {
      console.warn('could not list installed apps', e && e.message);
    }
    tree.library = this.layout.libraryNodes(installed);
    return { device: this.info, tree };
  }

  async apply({ tree }) {
    if (!this.layout) throw new Error('Open the layout first.');
    const next = this.layout.fromTree(tree);
    const before = new Set(allKeys(this.layout.raw));
    const after = new Set(allKeys(next));
    const removing = new Set((tree.hidden || []).map((n) => this.layout.keyOf(n.uid)).filter(Boolean));
    const missing = [...before].filter((k) => !after.has(k) && !removing.has(k));
    if (missing.length) {
      throw new Error(`Safety check stopped this: ${missing.length} app(s) would vanish without being marked for removal. Nothing was sent to the iPad.`);
    }
    const removed = [...before].filter((k) => removing.has(k) && !after.has(k));
    let readBack;
    if (this.demo) {
      this.demoCurrent = next;
      readBack = next;
    } else {
      this.backup(await this._getState(), 'before change');
      await this.sb.setIconState(next);
      readBack = await this._getState();
    }
    const cameBack = removed.filter((k) => new Set(allKeys(readBack)).has(k));
    const wanted = flattenIds(next).flat();
    const got = flattenIds(readBack).flat();
    const ok = JSON.stringify(flattenIds(next)) === JSON.stringify(flattenIds(readBack));
    const matched = wanted.filter((w, i) => got[i] === w).length;
    let message = ok
      ? 'Done! Your iPad now has the new layout.'
      : 'Your iPad adjusted the layout after receiving it (it may re-flow full pages). Reloading so you see exactly what it kept.';
    if (removed.length && !cameBack.length) message += ` ${removed.length} app(s) moved to the App Library.`;
    if (cameBack.length) message += ` The iPad put ${cameBack.length} removed app(s) back on the Home Screen, so this iPadOS version may not allow removing apps this way.`;
    return { ok: ok && !cameBack.length, matched, total: wanted.length, removed: removed.length, cameBack: cameBack.length, message };
  }

  backups() {
    if (!fs.existsSync(this.backupDir)) return { backups: [], folder: this.backupDir };
    const files = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.plist')).sort().reverse().slice(0, 60);
    return { backups: files.map((file) => ({ file })), folder: this.backupDir };
  }

  async restore({ file }) {
    const full = path.join(this.backupDir, path.basename(file));
    if (!fs.existsSync(full)) throw new Error('That backup no longer exists.');
    const state = bplist.parse(fs.readFileSync(full));
    if (this.demo) {
      this.demoCurrent = state;
    } else {
      if (!this.sb) await this.load({});
      this.backup(await this._getState(), 'before restore');
      await this.sb.setIconState(state);
    }
    return { ok: true };
  }

  async icon(bundleId) {
    if (this.demo) return { type: 'image/svg+xml', body: Buffer.from(demoIconSVG(bundleId)) };
    const safe = bundleId.replace(/[^A-Za-z0-9._-]/g, '_');
    const cached = path.join(this.iconDir, `${safe}.png`);
    if (fs.existsSync(cached)) return { type: 'image/png', body: fs.readFileSync(cached) };
    if (!this.sb) return null;
    let png = null;
    try { png = await this.sb.getIconPNG(bundleId); } catch { png = null; }
    if (!png || !png.length) return null;
    fs.mkdirSync(this.iconDir, { recursive: true });
    fs.writeFileSync(cached, png);
    return { type: 'image/png', body: png };
  }
}

module.exports = { Backend };
