'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appStoreGenres, buildPrompt, readAnswer, genreGroups, categorize } = require('../src/categorize');
const { AI, PROVIDERS } = require('../src/ai');

const APPS = [
  { id: 'a.spotify', name: 'Spotify', genre: 'Music' },
  { id: 'a.chess', name: 'Chess', genre: 'Games' },
  { id: 'a.wordle', name: 'Wordle', genre: 'Games' },
  { id: 'a.insta', name: 'Instagram', genre: 'Photo & Video' },
  { id: 'a.slack', name: 'Slack', genre: 'Business' },
];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arrange-test-'));

test('the prompt numbers apps and carries the person\'s notes', () => {
  const p = buildPrompt(APPS, { size: 'fewer', notes: 'Kids stuff together' });
  assert.match(p, /1\. Spotify \(Music\)/);
  assert.match(p, /5\. Slack \(Business\)/);
  assert.match(p, /about 6 categories/);
  assert.match(p, /Kids stuff together/);
});

test('reading the answer covers every app exactly once', () => {
  const reply = 'Sure!\n```json\n{"categories":[{"name":"Games","apps":[2,3,3]},{"name":"Fun","apps":[1,2,99]},{"name":"games","apps":[4]}]}\n```';
  const groups = readAnswer(APPS, reply);
  assert.deepStrictEqual(groups, [
    { name: 'Games', ids: ['a.chess', 'a.wordle', 'a.insta'] },
    { name: 'Fun', ids: ['a.spotify'] },
    { name: 'Other', ids: ['a.slack'] },
  ]);
});

test('an answer that is not JSON, or sorts nothing, is an error', () => {
  assert.throws(() => readAnswer(APPS, 'I cannot help with that'), /did not answer with categories/);
  assert.throws(() => readAnswer(APPS, '{"categories":[{"name":"X","apps":[42]}]}'), /did not put any apps/);
});

test('without an AI, App Store genres become groups and single apps go to Other', () => {
  const groups = genreGroups(APPS).map((g) => ({ ...g, ids: g.ids.sort() }));
  assert.deepStrictEqual(groups, [
    { name: 'Games', ids: ['a.chess', 'a.wordle'] },
    { name: 'Other', ids: ['a.insta', 'a.slack', 'a.spotify'] },
  ]);
});

test('App Store lookups are batched, cached, and retried in the US store', async () => {
  const file = path.join(tmp(), 'genres.json');
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const cc = new URL(url).searchParams.get('country');
    const results = cc === 'gb' ? [{ bundleId: 'a.spotify', primaryGenreName: 'Music' }] : [{ bundleId: 'a.chess', primaryGenreName: 'Games' }];
    return { ok: true, json: async () => ({ results }) };
  };
  const first = await appStoreGenres(['a.spotify', 'a.chess', 'a.nope'], { fetch, file, country: 'gb' });
  assert.deepStrictEqual(first, { 'a.spotify': 'Music', 'a.chess': 'Games', 'a.nope': null });
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0], /bundleId=a\.spotify,a\.chess,a\.nope/);
  const again = await appStoreGenres(['a.spotify', 'a.chess', 'a.nope'], { fetch, file, country: 'gb' });
  assert.deepStrictEqual(again, first);
  assert.strictEqual(calls.length, 2, 'served from the cache');
});

test('a failed App Store lookup still lets organizing work', async () => {
  const fetch = async () => { throw new Error('offline'); };
  const out = await appStoreGenres(['a.x'], { fetch, file: null });
  assert.deepStrictEqual(out, { 'a.x': null });
});

test('categorize uses the AI when given one, and genres when not', async () => {
  const lookup = async () => Object.fromEntries(APPS.map((a) => [a.id, a.genre]));
  const apps = APPS.map(({ id, name }) => ({ id, name }));
  const plain = await categorize(apps, { lookup });
  assert.strictEqual(plain.by, 'appstore');
  let asked = '';
  const ai = { ask: async (p) => { asked = p; return '{"categories":[{"name":"Play","apps":[1,2,3]},{"name":"Work","apps":[4,5]}]}'; } };
  const smart = await categorize(apps, { lookup, ai, notes: 'hi' });
  assert.strictEqual(smart.by, 'ai');
  assert.match(asked, /Chess \(Games\)/);
  assert.deepStrictEqual(smart.groups.map((g) => g.name), ['Play', 'Work']);
});

test('AI settings keep keys encrypted and never send them to the window', () => {
  const file = path.join(tmp(), 'ai.json');
  const crypt = { encrypt: (s) => `enc(${s})`, decrypt: (s) => s.slice(4, -1) };
  const ai = new AI({ file, crypt });
  ai.save({ id: 'anthropic', apiKey: 'sk-ant-secret-1234', model: 'claude-haiku-5-5', active: true });
  assert.match(fs.readFileSync(file, 'utf8'), /enc\(sk-ant-secret-1234\)/);
  const s = ai.settings();
  assert.strictEqual(s.active, 'anthropic');
  const p = s.providers.find((x) => x.id === 'anthropic');
  assert.strictEqual(p.hasKey, true);
  assert.strictEqual(p.keyHint, '…1234');
  assert.ok(!JSON.stringify(s).includes('secret'));
  assert.strictEqual(ai.activeName(), 'Claude API (claude-haiku-5-5)');
  ai.save({ id: 'anthropic', apiKey: '' });
  assert.strictEqual(ai.settings().providers.find((x) => x.id === 'anthropic').hasKey, false);
  ai.save({ id: 'anthropic', active: false });
  assert.strictEqual(ai.activeName(), null);
});

test('asking the Claude API and an OpenAI-style API', async () => {
  const sent = [];
  const fetch = async (url, opts) => {
    sent.push({ url, opts });
    const body = url.includes('anthropic')
      ? { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: '{"ok":true}' } }] };
    return { ok: true, json: async () => body };
  };
  const ai = new AI({ file: path.join(tmp(), 'ai.json'), fetch });
  ai.save({ id: 'anthropic', apiKey: 'k1', active: true });
  assert.strictEqual((await ai.test()).ok, true);
  assert.strictEqual(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(sent[0].opts.headers['x-api-key'], 'k1');
  ai.save({ id: 'compatible', baseUrl: 'http://localhost:1234/v1/', model: 'llama', active: true });
  assert.strictEqual(await ai.ask('hi'), '{"ok":true}');
  assert.strictEqual(sent[1].url, 'http://localhost:1234/v1/chat/completions');
  assert.ok(!('authorization' in sent[1].opts.headers), 'no key, no auth header');
});

test('API errors explain a rejected key', async () => {
  const fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  const ai = new AI({ file: path.join(tmp(), 'ai.json'), fetch });
  ai.save({ id: 'anthropic', apiKey: 'bad', active: true });
  await assert.rejects(ai.ask('hi'), /API key was not accepted: invalid x-api-key/);
});

test('reading Claude Code and Codex output', () => {
  const claude = PROVIDERS.find((p) => p.id === 'claude-code');
  assert.strictEqual(claude.parse('{"type":"result","is_error":false,"result":"{\\"ok\\":true}"}\n'), '{"ok":true}');
  assert.throws(() => claude.parse('{"is_error":true,"result":"Not logged in"}'), /Not logged in/);
  assert.ok(claude.args('haiku').includes('--tools'), 'tools are off');
  const codex = PROVIDERS.find((p) => p.id === 'codex');
  const out = ['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}', '{"type":"turn.completed"}'].join('\n');
  assert.strictEqual(codex.parse(out), 'done');
  assert.throws(() => codex.parse('{"type":"turn.failed","error":{"message":"Missing key"}}'), /Missing key/);
});

test('reading model lists from Codex, Cursor and OpenCode', () => {
  const p = (id) => PROVIDERS.find((x) => x.id === id);
  const codex = JSON.stringify({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }] });
  assert.deepStrictEqual(p('codex').list.parse(codex), [{ id: 'gpt-6-sol', name: 'GPT-6-Sol' }]);
  assert.deepStrictEqual(p('cursor-agent').list.parse('Available models\n\nauto - Auto\ngpt-5 - GPT-5  (current)\n\nTip: use --model'),
    [{ id: 'auto', name: 'Auto' }, { id: 'gpt-5', name: 'GPT-5' }]);
  assert.deepStrictEqual(p('opencode').list.parse('openai/gpt-5\n\x1b[2mopenrouter/~anthropic/claude-sonnet-latest\x1b[0m\n'),
    [{ id: 'openai/gpt-5', name: 'openai/gpt-5' }, { id: 'openrouter/~anthropic/claude-sonnet-latest', name: 'openrouter/~anthropic/claude-sonnet-latest' }]);
});

test('API model lists: Anthropic names, OpenAI without non-chat models, and a built-in list without a key', async () => {
  const fetch = async (url) => ({ ok: true, json: async () => (url.includes('anthropic')
    ? { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }
    : { data: [{ id: 'text-embedding-3-large' }, { id: 'gpt-6-sol' }, { id: 'whisper-1' }] }) });
  const ai = new AI({ file: path.join(tmp(), 'ai.json'), fetch });
  const none = await ai.models('anthropic');
  assert.strictEqual(none.from, 'builtin');
  assert.match(none.note, /Add your Claude API key/);
  ai.save({ id: 'anthropic', apiKey: 'k' });
  assert.deepStrictEqual(await ai.models('anthropic'), { models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }], from: 'live', note: '' });
  ai.save({ id: 'openai', apiKey: 'k' });
  assert.deepStrictEqual((await ai.models('openai')).models.map((m) => m.id), ['gpt-6-sol']);
});
