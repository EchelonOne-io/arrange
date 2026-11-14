'use strict';
// Talks to the iPhone or iPad over USB through Apple's usbmuxd (built into macOS; on
// Windows it comes with the Apple Devices app or iTunes). The connection and
// lockdown handshake come from appium-ios-device; the SpringBoard protocol and
// plist encoding are ours so the layout round-trips without losing precision.

const { utilities, services, Usbmux } = require('appium-ios-device');
const bplist = require('./bplist');
const { profileFor } = require('./profile');

const SPRINGBOARD = 'com.apple.springboardservices';

/** A message a person can act on. `d` names the device: "iPhone", "iPad", or both when unknown. */
function friendly(err, d = 'iPhone or iPad') {
  const text = String((err && err.message) || err || 'Unknown error');
  if (/pair record/i.test(text)) {
    return process.platform === 'darwin'
      ? `This Mac is not trusted by the ${d} yet. Unlock the ${d}, open Finder, click the ${d} in the sidebar, choose Trust, then tap Trust on the ${d}.`
      : `This computer is not trusted by the ${d} yet. Unlock the ${d}, open the Apple Devices app, then tap Trust on the ${d}.`;
  }
  if (/usbmuxd|ECONNREFUSED|ENOENT/i.test(text)) {
    return process.platform === 'win32'
      ? `Could not reach Apple's USB service. Install the Apple Devices app from the Microsoft Store, then plug the ${d} in again.`
      : `Could not reach the ${d}. Plug it in with a cable and unlock it.`;
  }
  if (/PasswordProtected|locked/i.test(text)) return `Unlock the ${d}, then try again.`;
  if (/Could not find the expected device|InvalidService|BADDEV/i.test(text)) return `The ${d} was disconnected. Plug it back in and unlock it.`;
  return text;
}

async function hasPairRecord(udid) {
  const { getDefaultSocket } = require('appium-ios-device/build/lib/usbmux');
  const mux = new Usbmux(await getDefaultSocket());
  try {
    return !!(await mux.readPairRecord(udid));
  } catch {
    return false;
  } finally {
    mux.close();
  }
}

async function listDevices() {
  const udids = await utilities.getConnectedDevices();
  const out = [];
  for (const udid of udids) {
    const entry = { udid, name: null, ios: null, model: null };
    try {
      const info = await utilities.getDeviceInfo(udid);
      entry.name = info.DeviceName;
      entry.ios = info.ProductVersion;
      entry.model = info.ProductType;
      if (!(await hasPairRecord(udid))) entry.error = friendly(new Error('pair record'), profileFor(entry.model).label);
    } catch (e) {
      entry.error = friendly(e, entry.model ? profileFor(entry.model).label : undefined);
    }
    out.push(entry);
  }
  return out;
}

/** One SpringBoard services connection. Requests are serialised. */
class SpringBoard {
  constructor(udid) {
    this.udid = udid;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.queue = Promise.resolve();
  }

  async connect() {
    const lockdown = await utilities.startLockdownSession(this.udid);
    let svc;
    try {
      svc = await lockdown.startService(SPRINGBOARD);
    } finally {
      lockdown.close();
    }
    if (!svc || !svc.Port) throw new Error('The device refused the Home Screen service.');
    this.socket = svc.EnableServiceSSL
      ? await utilities.connectPortSSL(this.udid, svc.Port)
      : await utilities.connectPort(this.udid, svc.Port);
    const sock = this.socket;
    sock.on('data', (d) => { if (this.socket !== sock) return; this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    const fail = (e) => {
      if (this.socket !== sock) return; // an old connection we already replaced
      this.socket = null;
      this.buf = Buffer.alloc(0);
      this.waiters.splice(0).forEach((w) => w.reject(e || new Error('The device was disconnected.')));
    };
    sock.on('error', fail);
    sock.on('close', () => fail());
  }

  close() {
    try { this.socket && this.socket.destroy(); } catch { /* ignore */ }
    this.socket = null;
  }

  _pump() {
    while (this.buf.length >= 4 && this.waiters.length) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const w = this.waiters.shift();
      try { w.resolve(decode(payload)); } catch (e) { w.reject(e); }
    }
  }

  _send(obj, { expectReply = true, timeout = 30000 } = {}) {
    const run = async () => {
      if (!this.socket) await this.connect();
      const body = bplist.build(obj);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      if (!expectReply) {
        this.socket.write(Buffer.concat([head, body]));
        return null;
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(Object.assign(new Error('The device did not answer in time.'), { timeout: true }));
        }, timeout);
        const w = {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        this.waiters.push(w);
        this.socket.write(Buffer.concat([head, body]));
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  getIconState() {
    return this._send({ command: 'getIconState', formatVersion: '2' });
  }

  async setIconState(state) {
    // SpringBoard does not reliably answer setIconState; we verify by reading back.
    await this._send({ command: 'setIconState', iconState: state }, { expectReply: false });
    await new Promise((r) => setTimeout(r, 1500));
    // Start a fresh connection so a late reply cannot be mistaken for the next answer.
    await this.queue;
    this.close();
    this.buf = Buffer.alloc(0);
  }

  async getIconPNG(bundleId) {
    const r = await this._send({ command: 'getIconPNGData', bundleId }, { timeout: 10000 });
    return r && r.pngData ? Buffer.from(r.pngData) : null;
  }
}

function decode(payload) {
  if (payload.toString('latin1', 0, 6) === 'bplist') return bplist.parse(payload);
  // Fallback for XML replies (older iOS / iPadOS versions).
  const { plist } = require('@appium/support');
  return plist.parsePlist(payload);
}

async function deviceInfo(udid) {
  const info = await utilities.getDeviceInfo(udid);
  return { udid, name: info.DeviceName, ios: info.ProductVersion, model: info.ProductType };
}

/** Apps installed on the device that a person would see (user apps + visible Apple apps). */
async function installedApps(udid) {
  const proxy = await services.startInstallationProxyService(udid);
  try {
    const apps = await proxy.listApplications({
      returnAttributes: ['CFBundleIdentifier', 'CFBundleDisplayName', 'CFBundleName', 'ApplicationType', 'SBAppTags'],
    });
    return Object.values(apps)
      .filter((a) => a.ApplicationType === 'User' || a.ApplicationType === 'System')
      .filter((a) => !(Array.isArray(a.SBAppTags) && a.SBAppTags.includes('hidden')))
      .map((a) => ({ id: a.CFBundleIdentifier, name: a.CFBundleDisplayName || a.CFBundleName || a.CFBundleIdentifier }));
  } finally {
    proxy.close();
  }
}

module.exports = { listDevices, SpringBoard, deviceInfo, installedApps, friendly };
