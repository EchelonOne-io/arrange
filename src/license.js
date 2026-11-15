'use strict';
// License keys sold through Polar (polar.sh). Polar issues the key when someone buys; the app
// activates it on this computer and re-checks it now and then. Everything works without a key
// except applying a layout to a real device.
const fs = require('fs');
const os = require('os');

// Fill these in from the Polar dashboard: Settings shows the organization ID, and the product's
// checkout link is the "Buy" button. Set ARRANGE_POLAR_SANDBOX=1 to test against sandbox.polar.sh
// (sandbox has its own organization, so set ARRANGE_POLAR_ORG_ID too).
const SANDBOX = process.env.ARRANGE_POLAR_SANDBOX === '1';
const CONFIG = {
  orgId: process.env.ARRANGE_POLAR_ORG_ID || '4cbba128-d4fc-4ecc-8c56-b1b5429d1c4b',
  buyUrl: process.env.ARRANGE_BUY_URL || 'https://buy.polar.sh/polar_cl_JaF7QJ37inrEezbP0mWjIfw8uj669scLnUfhq37sH4d',
  api: SANDBOX ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh',
};

const RECHECK_MS = 24 * 3600 * 1000; // re-validate online at most once a day
const OFFLINE_GRACE_MS = 14 * 24 * 3600 * 1000; // keep working this long without reaching Polar

class LicenseError extends Error {}

class License {
  constructor({ file, config = CONFIG, fetch = globalThis.fetch, now = Date.now }) {
    this.file = file;
    this.config = config;
    this.fetch = fetch;
    this.now = now;
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  write(data) {
    if (data) fs.writeFileSync(this.file, JSON.stringify(data, null, 2));
    else fs.rmSync(this.file, { force: true });
  }

  async post(path, body) {
    let res;
    try {
      res = await this.fetch(this.config.api + '/v1/customer-portal/license-keys/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: this.config.orgId, ...body }),
      });
    } catch {
      return { offline: true };
    }
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /** Checks a key with Polar. Resolves to the key details, or null if Polar says it isn't valid. */
  async validate(key, activationId) {
    const r = await this.post('validate', { key, activation_id: activationId || null });
    if (r.offline || r.status >= 500) return { offline: true };
    if (r.status === 200 && r.json && r.json.status === 'granted') return { key: r.json };
    return { invalid: true };
  }

  /** Registers a key on this computer and saves it. */
  async activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) throw new LicenseError('Paste your license key first.');
    const first = await this.validate(key);
    if (first.offline) throw new LicenseError('Could not reach the license server. Check your internet connection and try again.');
    if (first.invalid) throw new LicenseError('That license key wasn\'t recognized. Check it against your purchase email.');

    let activationId = null;
    if (first.key.limit_activations != null) {
      const r = await this.post('activate', { key, label: os.hostname() || 'Computer', meta: { platform: process.platform } });
      if (r.offline || r.status >= 500) throw new LicenseError('Could not reach the license server. Try again in a moment.');
      if (r.status === 403) {
        throw new LicenseError(`This key is already in use on ${first.key.limit_activations} computer(s), its limit. Deactivate it on one of them first (License › Deactivate), then try again.`);
      }
      if (r.status !== 200) throw new LicenseError('That license key couldn\'t be activated. Check it against your purchase email.');
      activationId = r.json.id;
    }
    const saved = { key, activationId, displayKey: first.key.display_key || null, checkedAt: this.now() };
    this.write(saved);
    return this.describe(saved);
  }

  /** Whether this computer is licensed. Re-checks with Polar when due; works offline for a grace period. */
  async status({ force = false } = {}) {
    const saved = this.read();
    if (!saved || !saved.key) return this.describe(null);
    if (!force && this.now() - (saved.checkedAt || 0) < RECHECK_MS) return this.describe(saved);
    const r = await this.validate(saved.key, saved.activationId);
    if (r.invalid) { this.write(null); return { ...this.describe(null), revoked: true }; }
    if (r.key) { saved.checkedAt = this.now(); this.write(saved); return this.describe(saved); }
    // Offline: keep working until the grace period runs out.
    return this.describe(this.now() - (saved.checkedAt || 0) < OFFLINE_GRACE_MS ? saved : null, { offline: true });
  }

  /** Frees this computer's activation so the key can be used on another one. */
  async deactivate() {
    const saved = this.read();
    if (saved && saved.activationId) {
      const r = await this.post('deactivate', { key: saved.key, activation_id: saved.activationId });
      if (r.offline || r.status >= 500) throw new LicenseError('Could not reach the license server, so this computer is still using one of your activations. Try again when you\'re online.');
    }
    this.write(null);
    return this.describe(null);
  }

  describe(saved, extra = {}) {
    return { licensed: !!saved, displayKey: saved ? saved.displayKey : null, buyUrl: this.config.buyUrl, ...extra };
  }
}

module.exports = { License, LicenseError, CONFIG };
