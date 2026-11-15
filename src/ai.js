'use strict';
// Talks to whichever AI the person set up: an agent CLI already on this computer (Claude Code,
// Codex, ...) or an API with their own key. Only used to sort apps into categories, so every
// CLI runs with tools off, in an empty folder, with the prompt on stdin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Built-in model lists, used when a tool has no way to list its own models (or listing fails).
const M = (list) => list.map(([id, name]) => ({ id, name }));
const CLAUDE = M([['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-fable-5-2', 'Claude Fable 5.2']]);
const GEMINI = M([['gemini-3.5-flash', 'Gemini 3.5 Flash'], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite'], ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)'], ['gemini-2.5-flash', 'Gemini 2.5 Flash'], ['gemini-2.5-pro', 'Gemini 2.5 Pro']]);
// "id - Name" or "id  Name (current)" lines, skipping headings and blank lines.
const parseLines = (out) => stripAnsi(out).split('\n').map((l) => l.trim())
  .map((l) => l.match(/^([\w./:@\[\]-]+)(\s+-\s+|\s{2,})?(.*)$/))
  .filter((m) => m && (m[2] || /[\d./:-]/.test(m[1])) && !/^(available|models?|usage|error|tip)/i.test(m[1]))
  .map((m) => ({ id: m[1], name: m[3].replace(/\s*\((current|default)\)\s*$/i, '').trim() || m[1] }));
// OpenAI's list includes embeddings, speech and image models that can't answer a chat.
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|search|davinci|babbage|sora/i;

const SYSTEM = 'You sort iPhone and iPad apps into Home Screen categories. Reply with JSON only, no other text.';

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

const PROVIDERS = [
  {
    id: 'claude-code', kind: 'cli', name: 'Claude Code', command: 'claude', site: 'https://claude.com/claude-code',
    blurb: 'Uses your Claude subscription through the Claude Code app.',
    // Claude Code has no command that lists models; it takes these aliases or a full model ID.
    models: [...M([['haiku', 'Haiku (latest)'], ['sonnet', 'Sonnet (latest)'], ['opus', 'Opus (latest)']]), ...CLAUDE], defaultModel: 'haiku',
    // Tools, MCP servers, plugins and settings off: a bare call costs a fraction of a cent.
    args: (m) => ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--disable-slash-commands', '--no-session-persistence', '--system-prompt', SYSTEM, ...(m ? ['--model', m] : [])],
    parse: (out) => {
      const r = JSON.parse(out.trim().split('\n').pop());
      if (r.is_error) throw new Error(r.result || 'Claude Code reported an error.');
      return r.result;
    },
  },
  {
    id: 'codex', kind: 'cli', name: 'Codex', command: 'codex', site: 'https://developers.openai.com/codex/cli',
    blurb: 'Uses your ChatGPT plan through the OpenAI Codex CLI.',
    models: [], defaultModel: '',
    list: { args: ['debug', 'models'], parse: (out) => JSON.parse(out).models.filter((m) => m.visibility !== 'hide').map((m) => ({ id: m.slug, name: m.display_name || m.slug })) },
    args: (m) => ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', ...(m ? ['--model', m] : []), '-'],
    parse: (out) => {
      let text = null; let err = null;
      for (const line of out.split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message') text = e.item.text;
        if (e.type === 'turn.failed' || e.type === 'error') err = (e.error && e.error.message) || e.message;
      }
      if (text == null) throw new Error(err || 'Codex did not answer.');
      return text;
    },
  },
  {
    id: 'gemini-cli', kind: 'cli', name: 'Gemini CLI', command: 'gemini', site: 'https://github.com/google-gemini/gemini-cli',
    blurb: 'Uses your Google account through the Gemini CLI.',
    models: GEMINI, defaultModel: '',
    args: (m) => (m ? ['--model', m] : []),
  },
  {
    id: 'cursor-agent', kind: 'cli', name: 'Cursor Agent', command: 'cursor-agent', site: 'https://cursor.com/cli',
    blurb: 'Uses your Cursor plan through the Cursor CLI.',
    models: [], defaultModel: '',
    list: { args: ['models'], parse: parseLines },
    args: (m) => ['-p', '--output-format', 'text', ...(m ? ['--model', m] : [])],
  },
  {
    id: 'opencode', kind: 'cli', name: 'OpenCode', command: 'opencode', site: 'https://opencode.ai',
    blurb: 'Uses whichever model you set up in OpenCode.',
    models: [], defaultModel: '',
    list: { args: ['models'], parse: (out) => stripAnsi(out).split('\n').map((l) => l.trim()).filter((l) => l && !/\s/.test(l)).map((id) => ({ id, name: id })) },
    args: (m) => ['run', ...(m ? ['--model', m] : [])],
  },
  {
    id: 'anthropic', kind: 'api', api: 'anthropic', name: 'Claude API', site: 'https://console.anthropic.com/settings/keys',
    blurb: 'Your own Anthropic API key.', baseUrl: 'https://api.anthropic.com',
    models: CLAUDE, defaultModel: 'claude-haiku-5-5',
  },
  {
    id: 'openai', kind: 'api', api: 'openai', name: 'OpenAI API', site: 'https://platform.openai.com/api-keys',
    blurb: 'Your own OpenAI API key.', baseUrl: 'https://api.openai.com/v1',
    models: [], defaultModel: '',
  },
  {
    id: 'gemini', kind: 'api', api: 'openai', name: 'Gemini API', site: 'https://aistudio.google.com/apikey',
    blurb: 'Your own Google AI Studio key.', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: GEMINI, defaultModel: 'gemini-3.5-flash',
  },
  {
    id: 'compatible', kind: 'api', api: 'openai', name: 'OpenAI-compatible', site: null,
    blurb: 'OpenRouter, Ollama, LM Studio or any server with an OpenAI-style API.', baseUrl: 'http://localhost:11434/v1',
    models: [], defaultModel: '', customUrl: true, keyOptional: true,
  },
];
const byId = (id) => PROVIDERS.find((p) => p.id === id);

// GUI apps on a Mac start without the shell's PATH, so look where these tools usually live too.
function extraDirs() {
  const h = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.APPDATA || '', 'npm'), path.join(h, '.local', 'bin'), path.join(h, '.bun', 'bin')];
  }
  return ['.local/bin', '.claude/local', '.npm-global/bin', '.bun/bin', '.opencode/bin', '.volta/bin', '.cargo/bin']
    .map((d) => path.join(h, d)).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
}

let shellPath = null;
function loginShellPath() {
  if (process.platform === 'win32') return Promise.resolve('');
  if (shellPath !== null) return Promise.resolve(shellPath);
  return new Promise((resolve) => {
    const mark = '__ARRANGE_PATH__';
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `printf "${mark}%s${mark}" "$PATH"`], { timeout: 8000 }, (_e, out) => {
      const m = String(out || '').match(new RegExp(`${mark}(.*)${mark}`));
      shellPath = m ? m[1] : '';
      resolve(shellPath);
    });
  });
}

async function childEnv() {
  const parts = [await loginShellPath(), process.env.PATH || '', ...extraDirs()].join(path.delimiter).split(path.delimiter);
  const env = { ...process.env, PATH: [...new Set(parts.filter(Boolean))].join(path.delimiter), NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const lastLines = (s, n = 4) => stripAnsi(s).trim().split('\n').filter(Boolean).slice(-n).join(' ').slice(0, 400);

/** Runs a command and resolves {code, out, err}. Rejects only when it can't start or times out. */
function exec(command, args, { input = null, timeout = 15000, cwd } = {}) {
  return childEnv().then((env) => new Promise((resolve, reject) => {
    // npm installs .cmd shims on Windows, which only start through the shell. Every
    // argument is fixed by us (the prompt goes on stdin), so simple quoting is enough.
    const win = process.platform === 'win32';
    const child = spawn(command, win ? args.map((a) => (/^[\w./=:-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)) : args,
      { env, cwd: cwd || os.tmpdir(), shell: win, windowsHide: true });
    let out = ''; let err = ''; let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000);
      reject(new Error(`${command} took longer than ${Math.round(timeout / 1000)} seconds and was stopped.`));
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${command} isn't installed on this computer.`) : e);
    });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input); else child.stdin.end();
  }));
}

class AI {
  /** crypt: {encrypt(str) -> str, decrypt(str) -> str}, Electron's safeStorage in the app. */
  constructor({ file, crypt = null, fetch = globalThis.fetch }) {
    this.file = file;
    this.crypt = crypt;
    this.fetch = fetch;
  }

  _read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { active: null, providers: {} }; }
  }

  _write(s) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  _key(saved) {
    if (!saved || !saved.apiKey) return '';
    if (saved.apiKey.startsWith('plain:')) return saved.apiKey.slice(6);
    try { return this.crypt ? this.crypt.decrypt(saved.apiKey) : ''; } catch { return ''; }
  }

  /** Settings for the window: never the key itself, only whether one is saved. */
  settings() {
    const s = this._read();
    return {
      active: byId(s.active) ? s.active : null,
      providers: PROVIDERS.map((p) => {
        const saved = s.providers[p.id] || {};
        return {
          id: p.id, kind: p.kind, name: p.name, blurb: p.blurb, site: p.site, models: p.models, command: p.command || null,
          customUrl: !!p.customUrl, keyOptional: !!p.keyOptional,
          model: saved.model ?? p.defaultModel, baseUrl: saved.baseUrl || p.baseUrl || '',
          hasKey: !!this._key(saved), keyHint: this._key(saved) ? `…${this._key(saved).slice(-4)}` : '',
        };
      }),
    };
  }

  /** Saves one provider's settings. apiKey: undefined keeps the saved key, '' removes it. */
  save({ id, model, baseUrl, apiKey, active }) {
    const p = byId(id);
    if (!p) throw new Error('Unknown AI provider.');
    const s = this._read();
    const saved = { ...(s.providers[id] || {}) };
    if (model !== undefined) saved.model = String(model).trim();
    if (baseUrl !== undefined && p.customUrl) saved.baseUrl = String(baseUrl).trim().replace(/\/+$/, '');
    if (apiKey !== undefined) {
      const k = String(apiKey).trim();
      if (!k) delete saved.apiKey;
      else saved.apiKey = this.crypt ? this.crypt.encrypt(k) : `plain:${k}`;
    }
    s.providers[id] = saved;
    if (active === true) s.active = id;
    if (active === false && s.active === id) s.active = null;
    this._write(s);
    return this.settings();
  }

  /** Which CLIs are installed, with their version. */
  async detect() {
    const out = {};
    await Promise.all(PROVIDERS.filter((p) => p.kind === 'cli').map(async (p) => {
      try {
        const r = await exec(p.command, ['--version'], { timeout: 15000 });
        const v = lastLines(r.out || r.err, 1).slice(0, 60);
        out[p.id] = r.code === 0 ? { installed: true, version: v } : { installed: false, error: lastLines(r.err || r.out) };
      } catch (e) {
        out[p.id] = { installed: false, error: e.message };
      }
    }));
    return out;
  }

  _config(id) {
    const s = this._read();
    const pid = id || s.active;
    const p = byId(pid);
    if (!p) return null;
    const saved = s.providers[pid] || {};
    return { p, model: saved.model ?? p.defaultModel, baseUrl: saved.baseUrl || p.baseUrl, key: this._key(saved) };
  }

  /** Name of the AI in use, for the window, or null when none is set up. */
  activeName() {
    const c = this._config();
    return c ? `${c.p.name}${c.model ? ` (${c.model})` : ''}` : null;
  }

  /**
   * Models to choose from: [{id, name}], asked from the tool or API itself when it can list them.
   * Resolves {models, from: 'live' | 'builtin', note} - note says why the live list wasn't used.
   */
  async models(id) {
    const c = this._config(id);
    if (!c) throw new Error('Unknown AI provider.');
    const builtin = (note = '') => ({ models: c.p.models, from: 'builtin', note });
    if (c.p.kind === 'cli') {
      if (!c.p.list) return builtin();
      try {
        const r = await exec(c.p.command, c.p.list.args, { timeout: 30000 });
        if (r.code !== 0) return builtin(lastLines(r.err || r.out) || `${c.p.name} couldn't list its models.`);
        const models = c.p.list.parse(r.out);
        return models.length ? { models, from: 'live', note: '' } : builtin(`${c.p.name} didn't list any models.`);
      } catch (e) {
        return builtin(e.message);
      }
    }
    if (!c.key && !c.p.keyOptional) return builtin(`Add your ${c.p.name} key to load the full list.`);
    try {
      const r = c.p.api === 'anthropic'
        ? await this._get(`${c.baseUrl}/v1/models?limit=1000`, { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' })
        : await this._get(`${c.baseUrl}/models`, c.key ? { authorization: `Bearer ${c.key}` } : {});
      let models = (r.data || []).map((m) => {
        const mid = String(m.id).replace(/^models\//, '');
        return { id: mid, name: m.display_name || mid };
      });
      if (c.p.id === 'openai') models = models.filter((m) => !NOT_CHAT.test(m.id));
      // Anthropic lists newest first; for the rest, sort by name.
      if (c.p.api !== 'anthropic') models.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      return models.length ? { models, from: 'live', note: '' } : builtin('The server didn\'t list any models.');
    } catch (e) {
      return builtin(e.message === 'fetch failed' ? `Could not reach ${c.baseUrl}.` : e.message);
    }
  }

  async _get(url, headers) {
    const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiError(res.status, body));
    return body;
  }

  /** Sends one prompt and resolves the reply text. id defaults to the active provider. */
  async ask(prompt, { id = null, timeout = 240000 } = {}) {
    const c = this._config(id);
    if (!c) throw new Error('Set up an AI first, in Settings.');
    if (c.p.kind === 'cli') {
      // An empty folder, so the tool has nothing of yours to look at.
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arrange-ai-'));
      try {
        const input = c.p.id === 'claude-code' ? prompt : `${SYSTEM}\n\n${prompt}`;
        const r = await exec(c.p.command, c.p.args(c.model), { input, timeout, cwd });
        if (r.code !== 0) throw new Error(`${c.p.name} stopped with an error: ${lastLines(r.err || r.out) || `exit code ${r.code}`}`);
        const text = c.p.parse ? c.p.parse(r.out) : stripAnsi(r.out).trim();
        if (!text) throw new Error(`${c.p.name} sent back an empty answer.`);
        return text;
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
    if (!c.key && !c.p.keyOptional) throw new Error(`Add your ${c.p.name} key in Settings first.`);
    if (!c.model) throw new Error(`Choose a ${c.p.name} model in Settings first.`);
    const signal = AbortSignal.timeout(timeout);
    if (c.p.api === 'anthropic') {
      const res = await this.fetch(`${c.baseUrl}/v1/messages`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: c.model, max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiError(res.status, body));
      if (body.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a larger model.');
      return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    const res = await this.fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
      body: JSON.stringify({ model: c.model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiError(res.status, body));
    return (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
  }

  /** A tiny round trip so the person knows the setup works. */
  async test(id) {
    const t = Date.now();
    const reply = await this.ask('Reply with this JSON exactly: {"ok":true}', { id, timeout: 120000 });
    if (!/"ok"\s*:\s*true/.test(reply)) throw new Error(`It answered, but not as expected: ${reply.slice(0, 120)}`);
    return { ok: true, seconds: Math.round((Date.now() - t) / 100) / 10 };
  }
}

function apiError(status, body) {
  const msg = (body && body.error && (body.error.message || body.error)) || (Array.isArray(body) && body[0] && body[0].error && body[0].error.message) || '';
  if (status === 401 || status === 403) return `The API key was not accepted${msg ? `: ${msg}` : '.'}`;
  return `The AI service answered with an error (${status})${msg ? `: ${String(msg).slice(0, 300)}` : '.'}`;
}

module.exports = { AI, PROVIDERS };
