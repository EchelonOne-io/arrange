'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { License, LicenseError } = require('../src/license');

const DAY = 24 * 3600 * 1000;
const config = { orgId: 'org', buyUrl: 'https://buy', api: 'https://polar.test' };

/** A fake Polar: `keys` maps key -> {limit, revoked}; set `offline` to simulate no network. */
function fakePolar(keys) {
  const polar = { offline: false, calls: [], activations: {} };
  let next = 1;
  polar.fetch = async (url, opts) => {
    if (polar.offline) throw new TypeError('fetch failed');
    const op = url.split('/').pop();
    const body = JSON.parse(opts.body);
    polar.calls.push(op);
    const k = keys[body.key];
    const reply = (status, json) => ({ status, json: async () => json });
    if (!k || k.revoked) return reply(404, { error: 'ResourceNotFound' });
    const acts = polar.activations[body.key] || (polar.activations[body.key] = []);
    if (op === 'validate') {
      if (body.activation_id && !acts.includes(body.activation_id)) return reply(404, { error: 'ResourceNotFound' });
      return reply(200, { status: 'granted', display_key: '****' + body.key.slice(-4), limit_activations: k.limit ?? null });
    }
    if (op === 'activate') {
      if (k.limit == null) return reply(403, { error: 'NotPermitted' });
      if (acts.length >= k.limit) return reply(403, { error: 'NotPermitted' });
      const id = 'act' + next++; acts.push(id); return reply(200, { id });
    }
    if (op === 'deactivate') {
      polar.activations[body.key] = acts.filter(a => a !== body.activation_id);
      return { status: 204, json: async () => null };
    }
  };
  return polar;
}

function setup(keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrange-lic-'));
  const polar = fakePolar(keys);
  const clock = { t: 1e12 };
  const lic = new License({ file: path.join(dir, 'license.json'), config, fetch: polar.fetch, now: () => clock.t });
  return { lic, polar, clock };
}

test('unlicensed by default, with the buy link', async () => {
  const { lic } = setup({});
  assert.deepStrictEqual(await lic.status(), { licensed: false, displayKey: null, buyUrl: 'https://buy' });
});

test('activates a key with an activation limit and uses it to re-check', async () => {
  const { lic, polar, clock } = setup({ 'KEY-1234': { limit: 2 } });
  const r = await lic.activate('  KEY-1234 ');
  assert.strictEqual(r.licensed, true);
  assert.strictEqual(r.displayKey, '****1234');
  assert.deepStrictEqual(polar.calls, ['validate', 'activate']);
  assert.strictEqual((await lic.status()).licensed, true);
  assert.strictEqual(polar.calls.length, 2, 'no network call within a day');
  clock.t += 2 * DAY;
  assert.strictEqual((await lic.status()).licensed, true);
  assert.strictEqual(polar.calls.at(-1), 'validate');
});

test('a key without an activation limit skips activation', async () => {
  const { lic, polar } = setup({ OPEN: {} });
  assert.strictEqual((await lic.activate('OPEN')).licensed, true);
  assert.deepStrictEqual(polar.calls, ['validate']);
});

test('rejects unknown keys and keys at their activation limit', async () => {
  const { lic, polar } = setup({ FULL: { limit: 1 } });
  await assert.rejects(lic.activate('NOPE'), LicenseError);
  polar.activations.FULL = ['elsewhere'];
  await assert.rejects(lic.activate('FULL'), /limit/);
  assert.strictEqual((await lic.status()).licensed, false);
});

test('a revoked key locks the app again', async () => {
  const keys = { K: { limit: 1 } };
  const { lic, clock } = setup(keys);
  await lic.activate('K');
  keys.K.revoked = true;
  clock.t += 2 * DAY;
  const r = await lic.status();
  assert.strictEqual(r.licensed, false);
  assert.strictEqual(r.revoked, true);
});

test('keeps working offline for the grace period, then locks until it can check', async () => {
  const { lic, polar, clock } = setup({ K: { limit: 1 } });
  await lic.activate('K');
  polar.offline = true;
  clock.t += 10 * DAY;
  assert.strictEqual((await lic.status()).licensed, true);
  clock.t += 10 * DAY;
  assert.strictEqual((await lic.status()).licensed, false);
  polar.offline = false;
  assert.strictEqual((await lic.status()).licensed, true, 'the saved key is kept and works once back online');
});

test('activating while offline explains what happened', async () => {
  const { lic, polar } = setup({ K: { limit: 1 } });
  polar.offline = true;
  await assert.rejects(lic.activate('K'), /internet/);
});

test('deactivating frees the activation for another computer', async () => {
  const { lic, polar } = setup({ K: { limit: 1 } });
  await lic.activate('K');
  assert.strictEqual((await lic.deactivate()).licensed, false);
  assert.deepStrictEqual(polar.activations.K, []);
  assert.strictEqual((await lic.activate('K')).licensed, true);
});
