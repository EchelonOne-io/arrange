'use strict';
// App logic independent of Electron, so it can be unit-tested with plain Node.

const fs = require('fs');
const path = require('path');
const bplist = require('./bplist');
const { Layout, allKeys, flattenIds, isParkingPage } = require('./layout');
const { demoState, demoIconSVG, demoInstalled } = require('./demo');
const { profileFor } = require('./profile');

const DEMO_DEVICES = [
  { udid: 'demo', name: 'Sample iPad', ios: '26.1', model: 'iPad16,3' },
  { udid: 'demo-iphone', name: 'Sample iPhone', ios: '26.1', model: 'iPhone18,1' },
];
const withProfile = (d) => ({ ...d, profile: profileFor(d.model) });

class Backend {
  constructor({ backupDir, iconDir, demo = false, device = null }) {
    this.backupDir = backupDir;
    this.iconDir = iconDir;
    this.demo = demo;
    this.deviceMod = device || require('./device');
    this.sb = null;
    this.info = null;
    this.layout = null;
    this.demoCurrent = {
      demo: demoState('ipad'),
      'demo-iphone': demoState('iphone'),
    };
    this.demoInstalled = demoInstalled();
  }

  /** "iPhone" or "iPad" for the open device, or a neutral name before one is open. */
  label() {
    return this.info ? this.info.profile.label : 'device';
  }

  backup(state, label) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
    const who = (this.info && this.info.name ? this.info.name : 'device').replace(/[^\w -]/g, '').slice(0, 30);
    const file = path.join(this.backupDir, `${stamp} ${who} (${label}).plist`);
    fs.writeFileSync(file, bplist.build(state));
    return file;
  }

  async devices() {
    if (this.demo) return { demo: true, devices: DEMO_DEVICES.map(withProfile) };
    try {
      return { demo: false, devices: (await this.deviceMod.listDevices()).map(withProfile) };
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
    this.info = withProfile(await this.deviceMod.deviceInfo(udid));
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
      const sample = DEMO_DEVICES.find((d) => d.udid === udid) || DEMO_DEVICES[0];
      raw = this.demoCurrent[sample.udid];
      this.info = withProfile(sample);
    } else {
      if (!udid) {
        const list = await this.deviceMod.listDevices();
        if (!list.length) throw new Error('No iPhone or iPad found. Plug it in with a cable and unlock it.');
        udid = list[0].udid;
      }
      await this._connect(udid);
      raw = await this._getState();
    }
    if (!Array.isArray(raw)) throw new Error(`The ${this.label()} sent a layout this app does not understand.`);
    this.backup(raw, 'opened');
    this.layout = new Layout(raw);
    const tree = this.layout.toTree();
    let installed = [];
    try {
      installed = this.demo ? this.demoInstalled : await this.deviceMod.installedApps(this.info.udid);
    } catch (e) {
      console.warn('could not list installed apps', e && e.message);
    }
    this.installed = installed;
    tree.library = this.layout.libraryNodes(installed);
    return { device: this.info, tree };
  }

  async apply({ tree }) {
    if (!this.layout) throw new Error('Open the layout first.');
    const { dockMax, label } = this.info.profile;
    if (dockMax && (tree.dock || []).length > dockMax) {
      throw new Error(`The ${label} Dock holds ${dockMax} items, and this layout has ${tree.dock.length} there. Move some out of the Dock first. Nothing was sent to the ${label}.`);
    }
    const next = this.layout.fromTree(tree);
    const before = new Set(allKeys(this.layout.raw));
    const onPages = new Set(allKeys(next));
    const removing = new Set((tree.hidden || []).map((n) => this.layout.keyOf(n.uid)).filter(Boolean));
    const removed = [...before].filter((k) => removing.has(k) && !onPages.has(k) && !this.layout.parked.has(k));
    // iOS puts any installed app missing from the layout back on the Home Screen, so every
    // App Library app (including ones just removed) goes into folders on one parking page.
    const park = this.layout.parkingPage(next, (this.installed || []).map((a) => a.id), [...removing]);
    if (park.count) next.push(park.page);
    const after = new Set(allKeys(next));
    const missing = [...before].filter((k) => !after.has(k));
    if (missing.length) {
      throw new Error(`Safety check stopped this: ${missing.length} app(s) would vanish from the layout. Nothing was sent to the ${label}.`);
    }
    let readBack;
    if (this.demo) {
      this.demoCurrent[this.info.udid] = next;
      readBack = next;
    } else {
      this.backup(await this._getState(), 'before change');
      this.backup(next, 'sent');
      await this.sb.setIconState(next);
      readBack = await this._getState();
    }
    // Compare everything except the parking page (iOS silently drops hidden system apps from it).
    const visible = (s) => flattenIds(s.filter((l) => !isParkingPage(l)));
    const cameBack = removed.filter((k) => new Set(allKeys(readBack.filter((l) => !isParkingPage(l)))).has(k));
    const wanted = visible(next).flat();
    const got = visible(readBack).flat();
    const ok = JSON.stringify(visible(next)) === JSON.stringify(visible(readBack));
    const matched = wanted.filter((w, i) => got[i] === w).length;
    let message = ok
      ? `Done! Your ${label} now has the new layout.`
      : `Your ${label} adjusted the layout after receiving it (it may re-flow full pages). Reloading so you see exactly what it kept.`;
    if (removed.length && !cameBack.length) message += ` ${removed.length} app(s) removed from your pages.`;
    if (park.count) {
      message += ` iOS insists every app has a spot, so your ${park.count} App Library app(s) are in "${'App Library'}" folders on the last page. Hide that page once (long-press the Home Screen, tap the page dots, untick it) and it stays hidden.`;
    }
    if (cameBack.length) message += ` ${cameBack.length} removed app(s) still ended up on your pages.`;
    return { ok: ok && !cameBack.length, matched, total: wanted.length, removed: removed.length, parked: park.count, cameBack: cameBack.length, message };
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
      this.demoCurrent[this.info ? this.info.udid : 'demo'] = state;
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
