'use strict';
// Converts SpringBoard's icon state <-> a simple tree for the interface.
// Every original item is kept verbatim (by uid) so anything we do not
// understand (widgets, stacks, web clips, new iPadOS fields) goes back
// to the iPad exactly as it came.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x);
const itemKey = (item) => (isObj(item) ? item.bundleIdentifier || item.displayIdentifier || null : null);
// Widgets, Smart Stacks and app widgets (iconType "app" with a UUID id) can also carry
// iconLists, so only real folders count: listType "folder", or (older formats) an item
// with icons inside and nothing that marks it as a widget.
const isWidget = (item) => isObj(item) && (item.iconType != null || 'elementType' in item || Array.isArray(item.elements));
const isFolder = (item) => isObj(item) && Array.isArray(item.iconLists)
  && (item.listType === 'folder' || (!isWidget(item) && item.iconLists.some((p) => Array.isArray(p) && p.length)));
const isApp = (item) => isObj(item) && !isFolder(item) && !isWidget(item) && !!itemKey(item);
const WIDGET_SIZES = new Set(['small', 'medium', 'large', 'extralarge']);
const PARK_NAME = 'App Library';
const PARK_FOLDER_MAX = 108; // iOS stopped filling a folder at 127 apps on an iPhone 17 Pro
const isParkingPage = (list) => Array.isArray(list) && list.length > 0
  && list.every((x) => isFolder(x) && String(x.displayName || '').startsWith(PARK_NAME));

function widgetSize(item) {
  // App placements (iconType "app" with a UUID id) have no gridSize and take one icon cell.
  if (item.gridSize == null && !Array.isArray(item.elements)) return 'icon';
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
    this.parked = new Map(); // app key -> original entry, for apps on our "App Library" parking page
    for (const entry of raw.slice(1)) {
      if (isParkingPage(entry)) {
        for (const f of entry) for (const app of f.iconLists.flat()) if (itemKey(app)) this.parked.set(itemKey(app), app);
      }
    }
  }

  /**
   * Installed apps that are not on the Home Screen. Apps sitting on the parking page count
   * as App Library apps, because that page only exists to hold them.
   */
  libraryNodes(installed) {
    const onScreen = new Set(allKeys(this.raw.filter((l) => !isParkingPage(l))));
    const known = new Set(installed.map((a) => a.id));
    installed = [...installed];
    for (const [id, app] of this.parked) if (!known.has(id)) installed.push({ id, name: app.displayName || id });
    const out = [];
    for (const app of installed) {
      if (!app.id || onScreen.has(app.id)) continue;
      const uid = `lib:${app.id}`;
      this.library.set(uid, app);
      out.push({ uid, kind: 'app', name: app.name || app.id, id: app.id, icon: `appicon://icon/${encodeURIComponent(app.id)}` });
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
      return { uid, kind: 'app', name: item.displayName || key, id: key, icon: `appicon://icon/${encodeURIComponent(key)}` };
    }
    if (isObj(item)) {
      let label = item.displayName || item.containerBundleIdentifier || item.bundleIdentifier || item.elementType || 'Widget';
      if (Array.isArray(item.elements) && item.elements.length) {
        const first = item.elements[0];
        if (isObj(first)) label = first.displayName || first.containerBundleIdentifier || label;
        if (item.elements.length > 1) label = `Stack (${item.elements.length})`;
      }
      const size = widgetSize(item);
      const node = { uid, kind: 'widget', name: String(label).split('.').pop(), size };
      if (size === 'icon' && item.bundleIdentifier) node.icon = `appicon://icon/${encodeURIComponent(item.bundleIdentifier)}`;
      return node;
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
      if (idx > 0 && isParkingPage(entry)) return; // rebuilt on every apply
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
      return this.entryFor(this.library.get(uid).id, this.library.get(uid).name);
    }
    if (!this.items.has(uid)) throw new Error(`Unknown item ${uid}`);
    return this.items.get(uid);
  }

  /** The best entry we have for an app: the device's own entry if we saw one, else a minimal one. */
  entryFor(id, name) {
    if (this.parked.has(id)) return this.parked.get(id);
    for (const item of this.items.values()) if (isApp(item) && itemKey(item) === id) return item;
    return { displayName: name || id, displayIdentifier: id, bundleIdentifier: id };
  }

  /**
   * iOS puts every installed app that is missing from a layout back onto the Home Screen.
   * To keep App Library apps out of the way, we park them in "App Library" folders on one
   * last page, which the person hides (or deletes) on the device.
   */
  parkingPage(state, installedIds, extraIds = []) {
    const placed = new Set(allKeys(state));
    const ids = [...new Set([...installedIds, ...this.parked.keys(), ...extraIds])].filter((id) => !placed.has(id));
    const apps = ids.map((id) => this.entryFor(id)).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    const folders = [];
    for (let i = 0; i < apps.length; i += PARK_FOLDER_MAX) {
      const chunk = apps.slice(i, i + PARK_FOLDER_MAX);
      const pages = [];
      for (let j = 0; j < chunk.length; j += 9) pages.push(chunk.slice(j, j + 9));
      folders.push({ displayName: folders.length ? `${PARK_NAME} ${folders.length + 1}` : PARK_NAME, listType: 'folder', iconLists: pages });
    }
    return { page: folders, count: apps.length };
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

module.exports = { Layout, allKeys, flattenIds, itemKey, isParkingPage };
