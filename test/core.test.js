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
  await assert.rejects(be.apply({ tree: bad }), /Safety check/);
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
