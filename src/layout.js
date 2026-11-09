'use strict';
// Converts SpringBoard's icon state <-> a simple tree for the interface.
// Every original item is kept verbatim (by uid) so anything we do not
// understand (widgets, stacks, web clips, new iPadOS fields) goes back
// to the iPad exactly as it came.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x);
const itemKey = (item) => (isObj(item) ? item.bundleIdentifier || item.displayIdentifier || null : null);
const isFolder = (item) => isObj(item) && Array.isArray(item.iconLists);
const isApp = (item) => isObj(item) && !isFolder(item) && !!itemKey(item) && !('elementType' in item) && item.iconType !== 'custom';
const WIDGET_SIZES = new Set(['small', 'medium', 'large', 'extralarge']);

function widgetSize(item) {
  const s = String(item.gridSize || 'small').toLowerCase();
  return WIDGET_SIZES.has(s) ? s : 'small';
}

class Layout {
  constructor(raw) {
    this.raw = raw;
    this.items = new Map();
    this.n = 0;
    this.passthrough = []; // [index, entry] for top-level entries that are not lists
    this.library = new Map(); // uid -> {id, name} for installed apps not on the Home Screen
  }

  /** Installed apps (from the iPad) that are not anywhere on the Home Screen. */
  libraryNodes(installed) {
    const onScreen = new Set(allKeys(this.raw));
    const out = [];
    for (const app of installed) {
      if (!app.id || onScreen.has(app.id)) continue;
      const uid = `lib:${app.id}`;
      this.library.set(uid, app);
      out.push({ uid, kind: 'app', name: app.name || app.id, id: app.id, icon: `ipadicon://icon/${encodeURIComponent(app.id)}` });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  _uid(item) {
    const uid = `u${++this.n}`;
    this.items.set(uid, item);
    return uid;
  }

  _node(item, insideFolder = false) {
    const uid = this._uid(item);
    if (isFolder(item) && !insideFolder) {
      const pages = item.iconLists.filter(Array.isArray).map((p) => p.map((c) => this._node(c, true)));
      return { uid, kind: 'folder', name: item.displayName || 'Folder', pages };
    }
    if (isApp(item)) {
      const key = itemKey(item);
      return { uid, kind: 'app', name: item.displayName || key, id: key, icon: `ipadicon://icon/${encodeURIComponent(key)}` };
    }
    if (isObj(item)) {
      let label = item.displayName || item.containerBundleIdentifier || item.elementType || 'Widget';
      if (Array.isArray(item.elements) && item.elements.length) {
        const first = item.elements[0];
        if (isObj(first)) label = first.displayName || first.containerBundleIdentifier || label;
        if (item.elements.length > 1) label = `Stack (${item.elements.length})`;
      }
      return { uid, kind: 'widget', name: String(label).split('.').pop(), size: widgetSize(item) };
    }
    return { uid, kind: 'other', name: 'Item' };
  }

  keyOf(uid) {
    if (this.items.has(uid)) return itemKey(this.items.get(uid));
    if (this.library.has(uid)) return this.library.get(uid).id;
    return null;
  }

  toTree() {
    const lists = [];
    this.raw.forEach((entry, idx) => {
      if (Array.isArray(entry)) lists.push(entry.map((i) => this._node(i)));
      else this.passthrough.push([idx, entry]);
    });
    return { dock: lists[0] || [], pages: lists.length > 1 ? lists.slice(1) : [[]] };
  }

  _build(node, insideFolder = false) {
    const uid = node.uid;
    if (node.kind === 'folder' && !insideFolder) {
      const base = this.items.has(uid) ? { ...this.items.get(uid) } : { listType: 'folder' };
      base.displayName = String(node.name || 'Folder').slice(0, 64);
      let pages = (node.pages || []).map((p) => p.map((c) => this._build(c, true))).filter((p) => p.length);
      if (!pages.length) pages = [[]];
      base.iconLists = pages;
      if (!base.listType) base.listType = 'folder';
      return base;
    }
    if (!this.items.has(uid) && this.library.has(uid)) {
      // An installed app that was only in the App Library, now placed on the Home Screen.
      const app = this.library.get(uid);
      return { displayName: app.name, displayIdentifier: app.id, bundleIdentifier: app.id };
    }
    if (!this.items.has(uid)) throw new Error(`Unknown item ${uid}`);
    return this.items.get(uid);
  }

  fromTree(tree) {
    const dock = (tree.dock || []).map((n) => this._build(n));
    const pages = [];
    for (const page of tree.pages || []) {
      const built = [];
      for (const n of page) {
        // An empty folder is dropped, like iPadOS does.
        if (n.kind === 'folder' && !(n.pages || []).some((p) => p.length)) continue;
        built.push(this._build(n));
      }
      if (built.length) pages.push(built);
    }
    const lists = [dock, ...(pages.length ? pages : [[]])];
    for (const [idx, entry] of this.passthrough) lists.splice(Math.min(idx, lists.length), 0, entry);
    return lists;
  }
}

function allKeys(state) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (isFolder(x)) walk(x.iconLists);
    else if (isApp(x)) out.push(itemKey(x));
  };
  walk(state);
  return out.sort();
}

function flattenIds(state) {
  return state.filter(Array.isArray).map((list) => list.map((item) => {
    if (isFolder(item)) {
      const inner = item.iconLists.flat().map((c) => itemKey(c) || '?').join(',');
      return `[${item.displayName}:${inner}]`;
    }
    return itemKey(item) || (isObj(item) && item.elementType) || 'widget';
  }));
}

module.exports = { Layout, allKeys, flattenIds, itemKey };
