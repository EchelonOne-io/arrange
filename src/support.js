'use strict';
// Help links. Problem reports, feedback and error reports all open a prefilled GitHub issue on the
// public arrange-releases repo. Nothing is sent by the app itself: the issue opens in the browser,
// where the person can read and edit it, and only GitHub's Submit button sends it.
const fs = require('fs');
const os = require('os');

const REPO = 'https://github.com/EchelonOne-io/arrange-releases';
const MAX_URL = 7500; // GitHub refuses prefilled issue links much longer than ~8 KB
const KEEP = 30; // errors kept in the log

/** Recent errors, kept in a small JSON file so a report can include them after a restart. */
class ErrorLog {
  constructor({ file, home = os.homedir() }) {
    this.file = file;
    this.home = home;
  }

  recent() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }

  record(err, where = 'app') {
    const scrub = (s) => String(s || '').split(this.home).join('~').slice(0, 800);
    const entry = {
      at: new Date().toISOString(),
      where,
      message: scrub(err && err.message ? err.message : err),
      stack: scrub(err && err.stack ? err.stack.split('\n').slice(1, 8).join('\n') : ''),
    };
    try { fs.writeFileSync(this.file, JSON.stringify([...this.recent(), entry].slice(-KEEP), null, 1)); } catch {}
  }

  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

/** App and system details for a report. Leaves out the device's name, which is often a person's name. */
function systemInfo({ version, device }) {
  const lines = [
    `- Arrange ${version}`,
    `- ${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()} (${process.arch})`,
  ];
  if (device) lines.push(`- Device: ${device.model || device.profile?.label || 'unknown'}${device.ios ? `, iOS ${device.ios}` : ''}`);
  return lines.join('\n');
}

function link(title, body) {
  return `${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

const SYSTEM_HEADING = '\n\n**System**\n';

/** The URL to open for `kind`: 'bug', 'feedback' or 'errors'. */
function issueUrl(kind, { version, device, errors = [] }) {
  const info = SYSTEM_HEADING + systemInfo({ version, device });
  if (kind === 'feedback') {
    return link('Feedback: ', 'What would make Arrange better for you?\n\n' + info);
  }
  if (kind === 'bug') {
    return link('Problem: ', '**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n1. \n' + info);
  }
  // Error report: newest errors first, dropping older ones until the link fits.
  const intro = 'Arrange collected these recent errors. Add what you were doing when they happened, if you can.\n\n';
  const fmt = (e) => `${e.at} (${e.where}): ${e.message}${e.stack ? '\n' + e.stack : ''}`;
  let list = [...errors].reverse();
  for (;;) {
    const log = list.length ? '```\n' + list.map(fmt).join('\n\n') + '\n```' : '_No errors recorded._';
    const url = link('Error report', intro + log + info);
    if (url.length <= MAX_URL || !list.length) return url;
    list = list.slice(0, -1);
  }
}

module.exports = { ErrorLog, issueUrl, systemInfo, REPO };
