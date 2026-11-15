'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ErrorLog, issueUrl, REPO } = require('../src/support');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arrange-')), 'errors.json');
const body = (url) => new URL(url).searchParams.get('body');

test('error log keeps recent errors, hides the home folder, and clears', () => {
  const log = new ErrorLog({ file: tmp(), home: '/Users/sam' });
  assert.deepStrictEqual(log.recent(), []);
  const e = new Error('cannot read /Users/sam/Documents/x');
  log.record(e, 'load');
  const [r] = log.recent();
  assert.strictEqual(r.where, 'load');
  assert.strictEqual(r.message, 'cannot read ~/Documents/x');
  assert.ok(!r.stack.includes('/Users/sam'));
  for (let i = 0; i < 40; i++) log.record(new Error('e' + i));
  assert.strictEqual(log.recent().length, 30);
  assert.strictEqual(log.recent().at(-1).message, 'e39');
  log.clear();
  assert.deepStrictEqual(log.recent(), []);
});

test('issue links go to the public repo with system details but not the device name', () => {
  const device = { name: "Sam's iPad", model: 'iPad13,4', ios: '26.1' };
  for (const kind of ['bug', 'feedback', 'errors']) {
    const url = issueUrl(kind, { version: '1.2.0', device });
    assert.ok(url.startsWith(REPO + '/issues/new?'));
    assert.match(body(url), /Arrange 1\.2\.0/);
    assert.match(body(url), /iPad13,4, iOS 26\.1/);
    assert.ok(!body(url).includes('Sam'));
  }
});

test('error report includes the newest errors and stays short enough for GitHub', () => {
  const errors = Array.from({ length: 30 }, (_, i) => ({ at: 't' + i, where: 'apply', message: 'boom ' + i + ' ' + 'x'.repeat(700), stack: 'at y'.repeat(200) }));
  const url = issueUrl('errors', { version: '1.0.0', errors });
  assert.ok(url.length <= 7500);
  assert.match(body(url), /boom 29 /);
  assert.ok(!body(url).includes('boom 0 '));
  assert.match(body(issueUrl('errors', { version: '1.0.0' })), /No errors recorded/);
});
