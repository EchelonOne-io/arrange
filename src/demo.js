'use strict';
const crypto = require('crypto');
const { PDate } = require('./bplist');

const DEMO_APPS = `Safari Mail Messages FaceTime Photos Camera Music Calendar Notes Reminders Maps Clock Weather
Files Settings Books Podcasts TV News Stocks Home Contacts Calculator Freeform Shortcuts Translate Measure Magnifier
Slack Zoom Notion Figma Procreate Netflix YouTube Spotify Kindle Duolingo Chrome Gmail Drive Docs Sheets Dropbox
Discord Reddit Twitch Instagram Pinterest Amazon Uber Airbnb Venmo Lightroom GoodNotes Things Obsidian 1Password
Keynote Pages Numbers GarageBand iMovie Clips Chess Minecraft Wordle Sudoku Headspace Strava`.split(/\s+/);

const HOME_APPS = [...DEMO_APPS];
const GAMES = new Set(['Chess', 'Minecraft', 'Wordle', 'Sudoku']);

function demoState() {
  const app = (name) => ({
    displayName: name,
    bundleIdentifier: `com.demo.${name.toLowerCase()}`,
    displayIdentifier: `com.demo.${name.toLowerCase()}`,
    iconModDate: new PDate(789652800.123456),
  });
  const apps = HOME_APPS.map(app);
  const dock = apps.slice(0, 6);
  const rest = apps.slice(6).filter((a) => !GAMES.has(a.displayName));
  const folder = { displayName: 'Games', listType: 'folder', iconLists: [[...GAMES].map(app)] };
  const widget = { elementType: 'widget', gridSize: 'medium', containerBundleIdentifier: 'com.apple.weather', displayName: 'Weather' };
  return [dock, [widget, ...rest.slice(0, 18)], [...rest.slice(18, 40), folder], rest.slice(40)];
}

function demoIconSVG(bundleId) {
  const name = DEMO_APPS.find((n) => `com.demo.${n.toLowerCase()}` === bundleId) || bundleId;
  const hue = Math.floor((parseInt(crypto.createHash('md5').update(name).digest('hex').slice(0, 2), 16) * 360) / 256);
  const letter = (name[0] || '?').toUpperCase().replace(/[<&>]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${hue},70%,45%)"/></linearGradient></defs><rect width="120" height="120" rx="27" fill="url(#g)"/><text x="60" y="78" font-family="-apple-system,Helvetica,Arial" font-size="56" font-weight="600" text-anchor="middle" fill="white">${letter}</text></svg>`;
}

const LIBRARY_ONLY = ['Tips', 'Compass', 'Voice Memos', 'Find My', 'Fitness', 'Journal'];
DEMO_APPS.push(...LIBRARY_ONLY.map((n) => n.replace(' ', '')));

function demoInstalled() {
  const ids = (n) => `com.demo.${n.replace(' ', '').toLowerCase()}`;
  return [...HOME_APPS, ...LIBRARY_ONLY].map((n) => ({ id: ids(n), name: n }));
}

module.exports = { demoState, demoIconSVG, demoInstalled };
