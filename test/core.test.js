'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bplist = require('../src/bplist');
const { Layout, allKeys } = require('../src/layout');
const { demoState } = require('../src/demo');
const { Backend } = require('../src/backend');

test('binary plist round-trips bit-for-bit, including sub-millisecond dates', () => {
  const state = demoState();
  state.push({ big: 2n ** 62n, neg: -5, real: new bplist.PReal(1), f: 1.5, data: Buffer.from([1, 2, 3]), uni: 'Café ☕', yes: true, nil: null, empty: {}, list: [] });
  const bytes = bplist.build(state);
  const back = bplist.parse(bytes);
  assert.strictEqual(back[0][0].iconModDate.secs, 789652800.123456);
  assert.ok(back[4].real instanceof bplist.PReal);
  assert.deepStrictEqual(bplist.build(back), bytes);
});

test('reads a plist written by Python plistlib (Apple format)', () => {
  // fixture.bplist = plistlib.dumps({"a":[1,2.5,"x"],"d":datetime(2026,1,1,12,0,0,123456)}, fmt=FMT_BINARY)
  const v = bplist.parse(fs.readFileSync(path.join(__dirname, 'fixture.bplist')));
  assert.strictEqual(v.a[0], 1);
  assert.strictEqual(v.a[1].value, 2.5);
  assert.strictEqual(v.a[2], 'x');
  assert.strictEqual(v.d.toDate().toISOString(), '2026-01-01T12:00:00.123Z');
  assert.ok(Math.abs(v.d.secs - 788961600.123456) < 1e-6, String(v.d.secs));
});

test('layout round-trip is identical and keeps unknown entries', () => {
  const state = demoState();
  state.splice(1, 0, { someFutureKey: true });
  const lay = new Layout(state);
  const tree = lay.toTree();
  assert.deepStrictEqual(lay.fromTree(tree), state);
});

test('moving apps and making a folder keeps every app', () => {
  const state = demoState();
  const lay = new Layout(state);
  const tree = lay.toTree();
  const app = tree.pages[0].splice(1, 1)[0];
  tree.dock.push(app);
  const [a, b] = tree.pages[1].splice(0, 2);
  tree.pages[1].unshift({ uid: 'new1', kind: 'folder', name: 'Work', pages: [[a, b]] });
  const out = lay.fromTree(tree);
  assert.strictEqual(out[0].at(-1).displayName, app.name);
  assert.strictEqual(out[2][0].displayName, 'Work');
  assert.strictEqual(out[2][0].listType, 'folder');
  assert.deepStrictEqual(allKeys(out), allKeys(state));
});

test('backend refuses a layout that drops apps, and applies a valid one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipo-'));
  const be = new Backend({ backupDir: path.join(dir, 'b'), iconDir: path.join(dir, 'i'), demo: true });
  const { tree } = await be.load();
  const bad = JSON.parse(JSON.stringify(tree));
  bad.pages[0].pop();
  // With the installed-app list unavailable, a dropped app has nowhere to go: refuse.
  const installed = be.installed;
  be.installed = [];
  await assert.rejects(be.apply({ tree: bad }), /Safety check/);
  be.installed = installed;
  tree.pages[0].reverse();
  const r = await be.apply({ tree });
  assert.strictEqual(r.ok, true);
  assert.ok(be.backups().backups.length >= 1);
  const file = be.backups().backups[0].file;
  await be.restore({ file });
});

test('apps can be removed to the App Library and added back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipo-'));
  const be = new Backend({ backupDir: path.join(dir, 'b'), iconDir: path.join(dir, 'i'), demo: true });
  let { tree } = await be.load();
  assert.strictEqual(tree.library.length, 6);
  const tips = tree.library.find((a) => a.name === 'Tips');
  const removed = tree.pages[0].pop();
  tree.pages[0].push(tips);
  tree.hidden = [removed, ...tree.library.filter((a) => a !== tips)];
  const r = await be.apply({ tree });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, 1);
  ({ tree } = await be.load());
  const names = tree.library.map((a) => a.name);
  assert.ok(names.includes(removed.name) && !names.includes('Tips'));
  assert.ok(tree.pages[0].some((n) => n.name === 'Tips'));
});

test('device kind comes from the model name', () => {
  const { profileFor } = require('../src/profile');
  assert.deepStrictEqual(
    [profileFor('iPhone17,1'), profileFor('iPod9,1'), profileFor('iPad14,3'), profileFor(undefined)].map((p) => [p.kind, p.cells, p.dockMax]),
    [['iphone', 24, 4], ['iphone', 24, 4], ['ipad', 30, null], ['ipad', 30, null]],
  );
});

test('sample iPhone loads with an iPhone layout and its 4-item Dock is enforced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipo-'));
  const be = new Backend({ backupDir: path.join(dir, 'b'), iconDir: path.join(dir, 'i'), demo: true });
  const { devices } = await be.devices();
  assert.deepStrictEqual(devices.map((d) => d.profile.kind), ['ipad', 'iphone']);
  const { device, tree } = await be.load({ udid: 'demo-iphone' });
  assert.strictEqual(device.profile.label, 'iPhone');
  assert.strictEqual(tree.dock.length, 4);
  const crowded = JSON.parse(JSON.stringify(tree));
  crowded.dock.push(crowded.pages[0].pop());
  await assert.rejects(be.apply({ tree: crowded }), /iPhone Dock holds 4/);
  const r = await be.apply({ tree });
  assert.match(r.message, /Your iPhone now has/);
  // the sample iPad keeps its own layout
  assert.strictEqual((await be.load({ udid: 'demo' })).tree.dock.length, 6);
});

test('widgets that carry iconLists are not treated as folders and round-trip untouched', () => {
  const appWidget = { displayIdentifier: 'D5758159-EA0E-456E-A9A0-5BC9D476B602', iconLists: [], iconType: 'app', bundleIdentifier: 'com.google.Gmail' };
  const stack = { iconLists: [], elements: [{ elementType: 'widget', containerBundleIdentifier: 'com.apple.mobilecal' }], gridSize: 'small' };
  const folder = { displayName: 'Work', listType: 'folder', iconLists: [[{ displayName: 'Mail', bundleIdentifier: 'com.apple.mobilemail', displayIdentifier: 'com.apple.mobilemail' }]] };
  const state = [[], [appWidget, stack, folder]];
  const lay = new Layout(state);
  const tree = lay.toTree();
  assert.deepStrictEqual(tree.pages[0].map((n) => n.kind), ['widget', 'widget', 'folder']);
  assert.strictEqual(tree.pages[0][0].name, 'Gmail');
  assert.strictEqual(tree.pages[0][0].size, 'icon'); // one cell, not a 2x2 widget
  assert.strictEqual(tree.pages[0][1].size, 'small');
  const out = lay.fromTree(tree);
  assert.deepStrictEqual(bplist.build(out), bplist.build(state));
  assert.ok(!('listType' in out[1][0]));
});

test('App Library apps are parked in folders on one last page, and that page stays out of the editor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipo-'));
  const be = new Backend({ backupDir: path.join(dir, 'b'), iconDir: path.join(dir, 'i'), demo: true });
  let { tree } = await be.load();
  const libCount = tree.library.length;
  assert.ok(libCount > 0);
  const pagesBefore = tree.pages.length;
  const removed = tree.pages[0].pop();
  tree.hidden = [removed, ...tree.library];
  const r = await be.apply({ tree });
  assert.strictEqual(r.parked, libCount + 1);
  assert.ok(/Hide that page/.test(r.message));
  const sent = be.demoCurrent[be.info.udid];
  const last = sent[sent.length - 1];
  assert.ok(last.every((f) => f.listType === 'folder' && f.displayName.startsWith('App Library')));
  // Reopening: the parking page is not shown as a page; its apps are in the App Library panel.
  ({ tree } = await be.load());
  assert.strictEqual(tree.pages.length, pagesBefore);
  assert.strictEqual(tree.library.length, libCount + 1);
  // Applying again rebuilds one parking page, not a second one.
  await be.apply({ tree });
  const again = be.demoCurrent[be.info.udid];
  assert.strictEqual(again.length, sent.length);
});

test('parking folders split before they reach the size iOS refuses', () => {
  const { Layout: L } = require('../src/layout');
  const lay = new L([[], []]);
  const ids = Array.from({ length: 250 }, (_, i) => `com.example.app${i}`);
  const { page, count } = lay.parkingPage([[], []], ids);
  assert.strictEqual(count, 250);
  assert.strictEqual(page.length, 3);
  assert.ok(page.every((f) => f.iconLists.flat().length <= 108));
});
