// Home Screen shape of the open device; the backend sends the real one on load.
const DEFAULT_PROFILE = {kind:'ipad', label:'iPad', os:'iPadOS', cols:6, rows:5, cells:30, dockMax:null};
let profile = DEFAULT_PROFILE;
const WIDGET_CELLS = {icon:1, small:4, medium:8, large:16, extralarge:24};
const $ = s => document.querySelector(s);

let nodes = {};      // uid -> {uid, kind, name, id, icon, size, pages:[[uid]] (folders)}
let S = null;        // {dock:[uid], pages:[[uid]], shelf:[uid], hidden:[uid], names:[page name] (from Organize, only shown here)}
let openFolder = null;
let selected = new Set();
let undoStack = [], redoStack = [];
let newId = 0;
let sortables = [];
let device = null;
let dirty = false;
const NEUTRAL = 'iPhone or iPad';

// ---------- helpers ----------
async function api(route, body){
  const r = await window.organizer.call(route, body);
  if(r.error) throw new Error(r.error);
  return r.result;
}
function toast(msg, kind='', ms=5000){
  const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + kind; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(()=> t.style.display='none', ms);
}
const snapshot = () => JSON.stringify({S, nodes});
function pushUndo(){ dirty = true; undoStack.push(snapshot()); if(undoStack.length>100) undoStack.shift(); redoStack = []; }
function restore(snap){ const o = JSON.parse(snap); S = o.S; nodes = o.nodes; if(openFolder && !nodes[openFolder]) openFolder=null; render(); }
function cells(uid){ const n = nodes[uid]; return n.kind==='widget' ? (WIDGET_CELLS[n.size]||4) : 1; }
const byName = (a,b) => nodes[a].name.localeCompare(nodes[b].name, undefined, {sensitivity:'base', numeric:true});

function ingest(list){
  return list.map(n => {
    const node = {...n};
    if(n.kind === 'folder') node.pages = n.pages.map(p => ingest(p));
    nodes[n.uid] = node;
    return n.uid;
  });
}

// ---------- loading ----------
let scanning = false, welcomeHTML = null, autoOpened = false;
function showWelcome(){ if(welcomeHTML){ $('#board').innerHTML = welcomeHTML; $('#side').hidden = true; $('#dot').classList.remove('on'); $('#devname').textContent = 'Not connected'; bindWelcome(); } updateButtons(); }
async function scan(quiet){
  if(S) return;
  scanning = true;
  if(!quiet) $('#devlist').innerHTML = `<p class="hint" style="text-align:center">Looking for your ${NEUTRAL}…</p>`;
  try{
    const r = await api('devices');
    const list = r.devices || [];
    if(r.error) { $('#devlist').innerHTML = `<p class="hint" style="text-align:center">${esc(r.error)}</p>`; return; }
    if(!list.length){ $('#devlist').innerHTML = `<p class="hint" style="text-align:center">No ${NEUTRAL} found yet.</p>`; return; }
    $('#devlist').innerHTML = '';
    for(const d of list){
      const el = document.createElement('div'); el.className = 'dev';
      const p = d.profile || DEFAULT_PROFILE;
      const sub = [p.label, d.ios ? `${p.os} ${d.ios}` : ''].filter(Boolean).join(' · ');
      el.innerHTML = `<div class="dev-kind ${p.kind}" aria-hidden="true"></div><div class="meta"><b>${esc(d.name || 'Apple device')}</b><div class="hint" style="margin:0">${esc(sub)}</div>${d.error?`<div class="err">${esc(d.error)}</div>`:''}</div>`;
      const b = document.createElement('button'); b.className='btn primary'; b.textContent='Open layout';
      b.onclick = () => load(d.udid);
      el.appendChild(b); $('#devlist').appendChild(el);
    }
    if(list.length === 1 && !list[0].error && !autoOpened){ autoOpened = true; load(list[0].udid); }
  }catch(e){ $('#devlist').innerHTML = `<p class="hint" style="text-align:center">${esc(e.message)}</p>`; }
  finally{ scanning = false; }
}
async function load(udid, quiet){
  if(!quiet) toast('Reading your Home Screen…', '', 20000);
  try{
    const r = await api('load', {udid});
    device = r.device;
    applyProfile(device.profile || DEFAULT_PROFILE);
    nodes = {}; openFolder = null; selected.clear(); undoStack = []; redoStack = []; dirty = false;
    S = { dock: ingest(r.tree.dock), pages: r.tree.pages.map(p => ingest(p)), shelf: [], hidden: ingest(r.tree.library || []), names: [] };
    if(!S.pages.length) S.pages.push([]);
    $('#dot').classList.add('on');
    $('#devname').textContent = `${device.name || profile.label}${device.ios ? ` · ${profile.os} ${device.ios}` : ''}`;
    render();
    if(!quiet) toast('Layout loaded. A backup copy was saved in Documents › Arrange Backups.', 'ok');
  }catch(e){ toast(e.message, 'err', 10000); }
}

// ---------- device profile ----------
/** Size the grids and word the screen for an iPhone or an iPad. */
function applyProfile(p){
  profile = p;
  const root = document.documentElement;
  root.dataset.device = p.kind;
  root.style.setProperty('--cols', p.cols);
  $('#apply').textContent = `Apply to ${p.label}`;
  $('#reload').title = `Throw away unapplied changes and read the layout from the ${p.label} again`;
  $('#tipsText').innerHTML = `Drag to move. Click icons to select several, then make a folder or move them together. Double-click a folder to open it. Nothing changes on the ${esc(p.label)} until you press <b>Apply to ${esc(p.label)}</b>, and a backup is saved first.`;
}
function resetProfile(){
  applyProfile(DEFAULT_PROFILE);
  delete document.documentElement.dataset.device;
  $('#apply').textContent = 'Apply';
}
const dockLabel = () => profile.dockMax ? `Dock · ${S ? S.dock.length : 0} of ${profile.dockMax}` : 'Dock';
const dockFull = () => !!profile.dockMax && S.dock.length >= profile.dockMax;

// ---------- rendering ----------
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function iconStyle(n){ return n.icon ? `background-image:url('${n.icon.replace(/'/g,'%27')}')` : ''; }
function tileHTML(uid){
  const n = nodes[uid]; const sel = selected.has(uid) ? ' sel' : '';
  if(n.kind === 'folder'){
    const minis = n.pages.flat().slice(0,9).map(u => `<i style="${iconStyle(nodes[u])}"></i>`).join('');
    return `<div class="tile folder${sel}" data-uid="${uid}" data-kind="folder" title="${esc(n.name)} (double-click to open)"><div class="ic">${minis}</div><div class="nm">${esc(n.name)}</div></div>`;
  }
  if(n.kind === 'widget' && n.size !== 'icon'){
    return `<div class="tile widget w-${n.size}${sel}" data-uid="${uid}" data-kind="widget" title="Widget: ${esc(n.name)}"><div class="wn">${esc(n.name)}</div><div class="ws">${n.size} widget</div></div>`;
  }
  const letter = esc((n.name||'?').slice(0,1).toUpperCase());
  return `<div class="tile${sel}" data-uid="${uid}" data-kind="${n.kind}" title="${esc(n.name)}${n.id ? '\n'+esc(n.id) : ''}"><div class="ic" style="${iconStyle(n)}" data-letter="${letter}"></div><div class="nm">${esc(n.name)}</div></div>`;
}
function render(){
  if(!S) return;
  sortables.forEach(s => s.destroy()); sortables = [];
  $('#side').hidden = false;
  const board = $('#board');
  let html = `<div class="dock"><div class="label" id="dockLabel">${dockLabel()}</div><div class="grid" data-c="dock">${S.dock.map(tileHTML).join('')}</div></div><div class="pages">`;
  S.pages.forEach((p, i) => {
    const used = p.reduce((a,u) => a + cells(u), 0);
    const over = used > profile.cells;
    const pname = S.names && S.names[i] ? ` · ${esc(S.names[i])}` : '';
    html += `<section class="page"><div class="page-head"><b>Page ${i+1}${pname}</b><span class="${over?'full':''}">${p.length} item${p.length===1?'':'s'}${over?` · more than fits, ${profile.os} will spill the rest to the next page`:''}</span><span class="spacer"></span>
      <button class="btn small" data-act="sortpage" data-i="${i}">A–Z</button>
      ${p.length===0 && S.pages.length>1 ? `<button class="btn small" data-act="delpage" data-i="${i}">Remove</button>`:''}</div>
      <div class="grid" data-c="page:${i}">${p.map(tileHTML).join('')}</div></section>`;
  });
  html += '</div>';
  board.innerHTML = html;
  $('#shelf').innerHTML = S.shelf.map(tileHTML).join('');
  S.hidden.sort(byName);
  $('#hidden').innerHTML = S.hidden.map(tileHTML).join('');
  $('#hiddenCount').textContent = S.hidden.length ? `(${S.hidden.length})` : '';

  // folder panel
  const fc = $('#folderCard');
  if(openFolder && nodes[openFolder]){
    const f = nodes[openFolder]; fc.hidden = false;
    $('#folderName').value = f.name;
    $('#folderPages').innerHTML = f.pages.map((p,i) => `${f.pages.length>1?`<div class="fpage-label">Folder page ${i+1}</div>`:''}<div class="grid" data-c="folder:${openFolder}:${i}">${p.map(tileHTML).join('')}</div>`).join('');
  } else { fc.hidden = true; openFolder = null; }

  // broken icons fall back to a letter
  document.querySelectorAll('.tile .ic[data-letter]').forEach(el => {
    const url = (el.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)||[])[1];
    if(!url){ el.textContent = el.dataset.letter; return; }
    const img = new Image(); img.onerror = () => { el.style.backgroundImage=''; el.textContent = el.dataset.letter; }; img.src = url;
  });

  document.querySelectorAll('[data-c]').forEach(el => {
    const c = el.dataset.c;
    sortables.push(new Sortable(el, {
      group: { name:'icons', put: (to, from, dragEl) => canPut(c, dragEl.dataset.kind, from.el === to.el) },
      animation: 140, ghostClass:'sortable-ghost', forceFallback:true, fallbackTolerance:3,
      onStart: () => pushUndo(),
      onEnd: () => { syncFromDOM(); setTimeout(render, 0); },
    }));
  });
  applySearch();
  updateButtons();
}
function canPut(c, kind, sameList){
  if(c.startsWith('folder:')) return kind === 'app' || kind === 'other';   // no folders or widgets inside folders
  if(c === 'hidden') return kind === 'app';
  if(c === 'dock') return kind !== 'widget' && (sameList || !dockFull());
  return true;
}
function syncFromDOM(){
  document.querySelectorAll('[data-c]').forEach(el => {
    const ids = [...el.children].map(t => t.dataset.uid).filter(Boolean);
    const c = el.dataset.c;
    if(c === 'dock') S.dock = ids;
    else if(c === 'shelf') S.shelf = ids;
    else if(c === 'hidden') S.hidden = ids;
    else if(c.startsWith('page:')) S.pages[+c.split(':')[1]] = ids;
    else if(c.startsWith('folder:')){ const [,uid,i] = c.split(':'); nodes[uid].pages[+i] = ids; }
  });
  // a folder that became empty disappears (iOS and iPadOS do the same)
  for(const [uid, n] of Object.entries(nodes)){
    if(n.kind === 'folder'){
      n.pages = n.pages.filter((p,i) => p.length || (i===0));
      if(!n.pages.flat().length && uid !== openFolder) removeEverywhere(uid);
    }
  }
}
function removeEverywhere(uid){
  // mutate lists in place so references held by callers stay valid
  const drop = list => { let i; while((i = list.indexOf(uid)) !== -1) list.splice(i, 1); };
  drop(S.dock); drop(S.shelf); drop(S.hidden); S.pages.forEach(drop);
  for(const n of Object.values(nodes)) if(n.kind==='folder') n.pages.forEach(drop);
}
function locate(uid){
  if(S.dock.includes(uid)) return {list:S.dock};
  if(S.shelf.includes(uid)) return {list:S.shelf};
  if(S.hidden.includes(uid)) return {list:S.hidden};
  for(const p of S.pages) if(p.includes(uid)) return {list:p};
  for(const n of Object.values(nodes)) if(n.kind==='folder') for(const p of n.pages) if(p.includes(uid)) return {list:p, folder:n.uid};
  return null;
}
function applySearch(){
  const q = $('#search').value.trim().toLowerCase();
  document.querySelectorAll('.tile').forEach(t => {
    const n = nodes[t.dataset.uid]; if(!n) return;
    let hay = (n.name + ' ' + (n.id||'')).toLowerCase();
    if(n.kind==='folder') hay += ' ' + n.pages.flat().map(u => nodes[u].name.toLowerCase()).join(' ');
    const hit = q && hay.includes(q);
    t.classList.toggle('dim', !!q && !hit);
    t.classList.toggle('hit', !!hit);
  });
}
function updateButtons(){
  const loaded = !!S;
  ['#apply','#sortall','#addpage','#organize'].forEach(s => $(s).disabled = !loaded);
  $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length;
  const bar = $('#selbar');
  bar.classList.toggle('show', selected.size > 0);
  $('#selcount').textContent = `${selected.size} selected`;
  const sel = $('#topage');
  sel.innerHTML = '<option value="">Move to…</option><option value="dock">Dock</option>' + (S?.pages || []).map((p,i) => `<option value="${i}">Page ${i+1}</option>`).join('') + '<option value="new">New page</option>';
}

// ---------- actions ----------
function sortList(list){ const widgets = list.filter(u => nodes[u].kind==='widget'); const rest = list.filter(u => nodes[u].kind!=='widget').sort(byName); return widgets.concat(rest); }
function sortAll(){
  pushUndo();
  const items = S.pages.flat().filter(u => nodes[u].kind !== 'widget').sort(byName);
  const pages = S.pages.map(p => p.filter(u => nodes[u].kind === 'widget'));
  let i = 0;
  for(const u of items){
    while(i < pages.length && pages[i].reduce((a,x)=>a+cells(x),0) + 1 > profile.cells) i++;
    if(i >= pages.length) pages.push([]);
    pages[i].push(u);
  }
  S.pages = pages.filter((p, idx) => p.length || idx === 0);
  S.names = [];
  render(); toast('Sorted A to Z across your pages. Widgets stayed on their pages.', 'ok');
}
function moveSelected(target){
  pushUndo();
  const ids = [...selected].filter(u => nodes[u]);
  ids.forEach(removeEverywhere);
  if(target === 'shelf') S.shelf.push(...ids);
  else if(target === 'hidden') S.hidden.push(...ids);
  else if(target === 'dock') {
    const fit = ids.filter(u => nodes[u].kind!=='widget');
    const room = profile.dockMax ? Math.max(0, profile.dockMax - S.dock.length) : fit.length;
    S.dock.push(...fit.slice(0, room));
    const left = ids.filter(u => !S.dock.includes(u));
    S.shelf.push(...left);
    if(fit.length > room) toast(`The ${profile.label} Dock holds ${profile.dockMax} items. The rest went to the shelf.`, 'err');
  }
  else if(target === 'new') S.pages.push(ids);
  else S.pages[+target].push(...ids);
  selected.clear(); render();
}
function makeFolder(){
  const ids = [...selected].filter(u => nodes[u] && (nodes[u].kind === 'app' || nodes[u].kind === 'other'));
  if(!ids.length){ toast('Select some apps first. Folders and widgets cannot go inside a folder.', 'err'); return; }
  pushUndo();
  const first = locate(ids[0]);
  const at = first && !first.folder ? first.list : S.pages[0];
  const pos = at.indexOf(ids[0]);
  ids.forEach(removeEverywhere);
  const uid = 'new' + (++newId);
  nodes[uid] = {uid, kind:'folder', name:'New Folder', pages:[ids]};
  const target = at === S.dock ? S.pages[0] : at;
  target.splice(Math.max(0, Math.min(pos, target.length)), 0, uid);
  selected.clear(); openFolder = uid; render();
  const inp = $('#folderName'); inp.focus(); inp.select();
}
function buildTree(){
  const node = uid => {
    const n = nodes[uid];
    if(n.kind === 'folder') return {uid, kind:'folder', name:n.name, pages:n.pages.map(p => p.map(node))};
    return {uid, kind:n.kind};
  };
  const pages = S.pages.map(p => p.map(node));
  if(S.shelf.length) pages.push(S.shelf.map(node));
  return {dock: S.dock.map(node), pages, hidden: S.hidden.map(uid => ({uid, kind: nodes[uid].kind}))};
}
async function apply(){
  const removing = S.hidden.filter(u => !u.startsWith('lib:')).length;
  if(removing && !confirm(`${removing} app(s) will come off your pages and go into the "App Library" folders on the last page. Continue?`)) return;
  if(S.shelf.length && !confirm(`${S.shelf.length} item(s) are still on the shelf. They will go onto a new last page. Continue?`)) return;
  const btn = $('#apply'); btn.disabled = true; btn.textContent = 'Applying…';
  try{
    const r = await api('apply', {tree: buildTree()});
    if(r.needsLicense){ showLicense(); return; }
    toast(r.message + (r.ok ? '' : ` (${r.matched} of ${r.total} items landed exactly where you put them.)`), r.ok ? 'ok' : 'err', 12000);
    dirty = false;
    setTimeout(() => load(device?.udid, true), r.ok ? 300 : 600);
  }catch(e){ toast(e.message, 'err', 12000); }
  finally{ btn.textContent = `Apply to ${profile.label}`; btn.disabled = false; }
}
// ---------- license ----------
let lic = {licensed:false, buyUrl:null};
function setLicense(l){
  lic = l;
  // Buying stays one click away in the toolbar until there's a license; after that it lives in Settings.
  $('#licbtn').hidden = !!l.licensed;
  $('#navlic').textContent = l.licensed ? '' : 'NOT ACTIVE';
  $('#licon').hidden = !l.licensed; $('#licoff').hidden = l.licensed;
  $('#lictitle').textContent = l.licensed ? 'License' : 'Unlock Arrange';
  $('#licshown').textContent = l.displayKey ? ` (key ${l.displayKey})` : '';
  $('#licerr').hidden = $('#licerr2').hidden = true;
}
function showLicense(){ showSettings('page:license'); }
function loadLicense(){ setLicense(lic); $('#lickey').value = ''; if(!lic.licensed) setTimeout(() => $('#lickey').focus(), 0); }
async function busy(btn, label, fn, errEl){
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try{ await fn(); }
  catch(e){ errEl.textContent = e.message; errEl.hidden = false; }
  finally{ btn.disabled = false; btn.textContent = old; }
}
$('#licbtn').onclick = showLicense;
$('#licbuy').onclick = () => { if(lic.buyUrl) window.open(lic.buyUrl); };
$('#licgo').onclick = () => busy($('#licgo'), 'Activating…', async () => {
  setLicense(await api('activate', {key: $('#lickey').value}));
  toast('Activated. You can apply layouts to your devices now.', 'ok');
}, $('#licerr'));
$('#lickey').onkeydown = e => { if(e.key === 'Enter') $('#licgo').click(); };
$('#licdeact').onclick = () => busy($('#licdeact'), 'Deactivating…', async () => {
  setLicense(await api('deactivate')); toast('Deactivated on this computer.', 'ok');
}, $('#licerr2'));
api('license').then(l => { setLicense(l); if(l.revoked) toast('Your license key is no longer valid, so applying to a device is locked again.', 'err', 12000); }).catch(() => {});

function showBackups(){ showSettings('page:backups'); }
async function loadBackups(){
  const r = await api('backups');
  $('#bkfolder').textContent = `Saved in ${r.folder}`;
  $('#bklist').innerHTML = (r.backups||[]).map(b => `<div class="bk"><span class="mono">${esc(b.file)}</span><button class="btn small" data-file="${esc(b.file)}">Restore</button></div>`).join('') || '<p class="hint">No backups yet.</p>';
  $('#bklist').querySelectorAll('button').forEach(b => b.onclick = async () => {
    if(!confirm(`Put this saved layout back on the ${device ? profile.label : NEUTRAL}? Your current layout is backed up first.`)) return;
    try{ await api('restore', {file: b.dataset.file}); $('#setdlg').close(); toast('Restored. Reloading…', 'ok'); setTimeout(() => load(device?.udid), 1200); }
    catch(e){ toast(e.message, 'err', 10000); }
  });
}

// ---------- events ----------
document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if(act){
    const i = +act.dataset.i; pushUndo();
    if(act.dataset.act === 'sortpage') S.pages[i] = sortList(S.pages[i]);
    if(act.dataset.act === 'delpage'){ S.pages.splice(i, 1); if(S.names) S.names.splice(i, 1); }
    render(); return;
  }
  const t = e.target.closest('.tile');
  if(t && !e.target.closest('dialog')){
    const uid = t.dataset.uid;
    selected.has(uid) ? selected.delete(uid) : selected.add(uid);
    t.classList.toggle('sel'); updateButtons();
  }
});
document.addEventListener('dblclick', e => {
  const t = e.target.closest('.tile.folder'); if(!t) return;
  selected.delete(t.dataset.uid); openFolder = t.dataset.uid; render();
});
document.addEventListener('keydown', e => {
  if(e.target.matches('input')) return;
  if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='z'){ e.preventDefault(); (e.shiftKey ? $('#redo') : $('#undo')).click(); }
  if(e.key === 'Escape'){ selected.clear(); render(); }
});
$('#undo').onclick = () => { if(!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); };
$('#redo').onclick = () => { if(!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); };
$('#sortall').onclick = sortAll;
$('#addpage').onclick = () => { pushUndo(); S.pages.push([]); render(); window.scrollTo({top:document.body.scrollHeight, behavior:'smooth'}); };
$('#reload').onclick = () => { if(dirty && !confirm(`Discard your unapplied changes and reload from the ${profile.label}?`)) return; S ? load(device?.udid) : scan(); };
function bindWelcome(){
  $('#rescan').onclick = () => scan();
  $('#trydemo').onclick = async () => { await api('demo', {on:true}); autoOpened = false; $('#leavedemo').hidden = false; scan(); };
  $('#trusthint').textContent = window.organizer.platform === 'win32'
    ? `First time? Install the Apple Devices app from the Microsoft Store, plug in the ${NEUTRAL}, and tap Trust on it.`
    : `First time on this Mac? Plug in the ${NEUTRAL}, open Finder, click it in the sidebar and choose Trust, then tap Trust on the device.`;
}
welcomeHTML = $('#board').innerHTML;
bindWelcome();
$('#leavedemo').onclick = async () => {
  if(dirty && !confirm('Leave the sample? Your changes to it will be lost.')) return;
  await api('demo', {on:false}); $('#leavedemo').hidden = true; S = null; device = null; autoOpened = false; resetProfile(); showWelcome(); scan();
};
$('#bkshow').onclick = () => api('showBackups');
// keep looking while nothing is open, so plugging in "just works"
setInterval(() => { if(!S && !document.hidden && !scanning) scan(true); }, 3000);
$('#apply').onclick = apply;
$('#search').oninput = applySearch;
$('#mkfolder').onclick = makeFolder;
$('#toshelf').onclick = () => moveSelected('shelf');
$('#tohidden').onclick = () => {
  const apps = [...selected].filter(u => nodes[u] && nodes[u].kind === 'app');
  if(!apps.length){ toast('Select apps to remove. Folders and widgets can\'t be removed this way.', 'err'); return; }
  selected = new Set(apps); moveSelected('hidden');
};
$('#topage').onchange = e => { if(e.target.value !== '') moveSelected(e.target.value); };
$('#clearsel').onclick = () => { selected.clear(); render(); };
$('#folderName').oninput = e => { if(openFolder){ nodes[openFolder].name = e.target.value || 'Folder'; document.querySelectorAll(`.tile[data-uid="${openFolder}"] .nm`).forEach(x => x.textContent = nodes[openFolder].name); } };
$('#folderName').onfocus = () => pushUndo();
$('#folderSort').onclick = () => { pushUndo(); const f = nodes[openFolder]; const all = f.pages.flat().sort(byName); f.pages = []; for(let i=0;i<all.length;i+=9) f.pages.push(all.slice(i,i+9)); if(!f.pages.length) f.pages=[[]]; render(); };
$('#folderAddPage').onclick = () => { pushUndo(); nodes[openFolder].pages.push([]); render(); };
$('#folderUnpack').onclick = () => { pushUndo(); const f = nodes[openFolder]; S.shelf.push(...f.pages.flat()); f.pages = [[]]; const uid = openFolder; openFolder = null; removeEverywhere(uid); render(); };
$('#folderClose').onclick = () => { openFolder = null; syncFromDOM(); render(); };
window.addEventListener('beforeunload', e => { if(dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- organize by category ----------
let orgGroups = null; // [{name, ids:[bundle id]}] while the plan is shown
let orgBy = null;
let orgSortables = [];
let aiActive = null;  // "Claude Code (haiku)" or null

/** Apps that Organize moves: everything on the pages and the shelf, and inside folders if asked. */
function organizableApps(includeFolders){
  const out = [];
  const take = list => list.forEach(u => {
    const n = nodes[u];
    if(n.kind === 'app' && n.id) out.push(u);
    else if(n.kind === 'folder' && includeFolders) n.pages.flat().forEach(c => { if(nodes[c].kind === 'app' && nodes[c].id) out.push(c); });
  });
  S.pages.forEach(take); take(S.shelf);
  return out;
}
/** Splits items into pages without going over the page size; each call starts on a new page. */
function packPages(items){
  const pages = [[]]; let used = 0;
  for(const u of items){
    const c = cells(u);
    if(used + c > profile.cells && pages[pages.length-1].length){ pages.push([]); used = 0; }
    pages[pages.length-1].push(u); used += c;
  }
  return pages;
}
function arrangeByCategory(groups, mode, includeFolders){
  pushUndo();
  const moving = new Set(organizableApps(includeFolders));
  const uidsById = {};
  for(const u of moving) (uidsById[nodes[u].id] ||= []).push(u);
  // What stays: widgets, other items, and folders that aren't being emptied, in their current order.
  // Kept page by page, so a widget on page 3 stays apart from one on page 1 instead of being merged forward.
  const kept = u => {
    const n = nodes[u];
    if(moving.has(u)) return false;
    if(n.kind === 'folder' && includeFolders){ n.pages.forEach(p => { for(let i=p.length-1;i>=0;i--) if(moving.has(p[i])) p.splice(i,1); }); if(!n.pages.flat().length) return false; }
    return true;
  };
  const keepPages = [...S.pages, S.shelf].map(p => p.filter(kept)).filter(p => p.length);
  // Folders the person had are now empty; drop them from every list (and from their parent folder pages).
  for(const u of moving) removeEverywhere(u);
  const placed = new Set();
  const sections = groups.map(g => {
    const uids = g.ids.flatMap(id => uidsById[id] || []).filter(u => !placed.has(u) && (placed.add(u), true));
    return {name: g.name, uids: uids.sort(byName)};
  }).filter(s => s.uids.length);
  const left = [...moving].filter(u => !placed.has(u)).sort(byName);
  if(left.length) sections.push({name:'Other', uids:left});

  const pages = []; const names = [];
  const addPages = (items, name) => packPages(items).forEach(p => { if(p.length){ pages.push(p); names.push(name); } });
  keepPages.forEach(p => addPages(p, ''));
  if(mode === 'folders'){
    const tiles = sections.map(s => {
      if(s.uids.length < 2) return s.uids[0];
      const uid = 'new' + (++newId);
      const fp = []; for(let i=0;i<s.uids.length;i+=9) fp.push(s.uids.slice(i,i+9));
      nodes[uid] = {uid, kind:'folder', name:s.name.slice(0,64), pages:fp};
      return uid;
    });
    // Folders go after what was kept, filling the last kept page first.
    const last = pages.length ? pages.pop() : [];
    if(names.length) names.pop();
    addPages([...last, ...tiles], '');
  } else {
    sections.forEach(s => addPages(s.uids, s.name));
  }
  S.pages = pages.length ? pages : [[]];
  S.names = names;
  S.shelf = [];
  selected.clear(); openFolder = null;
  render();
  const what = mode === 'folders' ? `${sections.filter(s => s.uids.length > 1).length} folders` : `${sections.length} categories across ${pages.length} pages`;
  toast(`Arranged into ${what}. Press Apply to ${profile.label} when it looks right, or Undo to go back.`, 'ok', 9000);
}

async function refreshAIActive(){ aiActive = await api('aiActive').catch(() => null); }
async function showOrganize(){
  await refreshAIActive();
  $('#orgai').innerHTML = aiActive
    ? `<label class="row" style="gap:6px"><input type="checkbox" id="orguseai" checked> Sort with <b>${esc(aiActive)}</b></label>`
    : `<b>No AI set up.</b> Apps are grouped by their App Store category. <span class="hint">Set up AI for smarter groups like Kids or Work.</span>`;
  $('#orgaiset').textContent = aiActive ? 'Change…' : 'Set up AI…';
  const syncAI = () => { const on = !!aiActive && $('#orguseai')?.checked; $('#orgnotesrow').hidden = !on; $('#orgaiprivacy').hidden = !on; };
  if($('#orguseai')) $('#orguseai').onchange = syncAI;
  syncAI();
  $('#orgerr').hidden = true;
  $('#orgstep1').hidden = false; $('#orgstep2').hidden = true;
  $('#orgdlg').showModal();
}
async function suggestCategories(){
  const includeFolders = $('#orgfolders').checked;
  const uids = organizableApps(includeFolders);
  const seen = new Set();
  const apps = uids.map(u => nodes[u]).filter(n => !seen.has(n.id) && (seen.add(n.id), true)).map(n => ({id:n.id, name:n.name}));
  if(apps.length < 2){ $('#orgerr').textContent = 'There aren\'t enough apps on your pages to organize.'; $('#orgerr').hidden = false; return; }
  const useAI = !!aiActive && !!$('#orguseai')?.checked;
  const btn = $('#orggo'); const again = $('#orgagain');
  btn.disabled = again.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${useAI ? 'Asking the AI… this can take a minute' : 'Looking up categories…'}`;
  $('#orgerr').hidden = true;
  try{
    const r = await api('categorize', {apps, useAI, size: $('#orgsize').value, notes: $('#orgnotes').value.trim()});
    orgGroups = r.groups; orgBy = r.by;
    showPlan();
  }catch(e){
    $('#orgstep1').hidden = false; $('#orgstep2').hidden = true;
    $('#orgerr').textContent = e.message; $('#orgerr').hidden = false;
  }finally{ btn.disabled = again.disabled = false; btn.textContent = 'Suggest categories'; }
}
function planSummary(){
  const mode = document.querySelector('input[name=orgmode]:checked').value;
  const used = orgGroups.filter(g => g.ids.length);
  const total = used.reduce((a,g) => a + g.ids.length, 0);
  $('#orgsummary').textContent = `${total} apps in ${used.length} categories, ${mode === 'folders' ? 'each in a folder' : 'each on its own page'}. ${orgBy === 'ai' ? `Sorted by ${aiActive}.` : 'Grouped by App Store category.'}`;
}
/** Reads the categories back from the chips after a drag. Dropping on "New category" makes one. */
function readPlan(){
  $('#orgcats').querySelectorAll('[data-chips]').forEach(c => {
    const ids = [...c.children].map(x => x.dataset.id).filter(Boolean);
    if(c.dataset.chips === 'new'){ if(ids.length) orgGroups.push({name:'New Category', ids, fresh:true}); }
    else orgGroups[+c.dataset.chips].ids = ids;
  });
}
function showPlan(){
  const icon = id => { for(const n of Object.values(nodes)) if(n.id === id && n.icon) return n.icon; return ''; };
  const name = id => { for(const n of Object.values(nodes)) if(n.id === id) return n.name; return id; };
  const chip = id => `<span class="chip" data-id="${esc(id)}" title="Drag to another category"><i style="${iconStyle({icon:icon(id)})}"></i>${esc(name(id))}</span>`;
  planSummary();
  $('#orgcats').innerHTML = orgGroups.map((g,i) => `<div class="cat"><div class="cat-head"><input data-cat="${i}" value="${esc(g.name)}" maxlength="30" aria-label="Category name"><span>${g.ids.length}</span></div>
    <div class="chips" data-chips="${i}">${g.ids.map(chip).join('')}</div></div>`).join('')
    + `<div class="cat new"><div class="cat-head"><b>+ New category</b><span>Drag apps here to start one</span></div><div class="chips" data-chips="new"></div></div>`;
  $('#orgcats').querySelectorAll('input[data-cat]').forEach(inp => inp.oninput = () => { orgGroups[+inp.dataset.cat].name = inp.value.trim() || 'Other'; });
  const fresh = orgGroups.findIndex(g => g.fresh);
  if(fresh >= 0){ delete orgGroups[fresh].fresh; const inp = $(`#orgcats input[data-cat="${fresh}"]`); inp.scrollIntoView({block:'nearest'}); inp.focus(); inp.select(); }
  orgSortables.forEach(s => s.destroy());
  const mark = el => $('#orgcats').querySelectorAll('.cat').forEach(c => c.classList.toggle('drop', !!el && c.contains(el)));
  orgSortables = [...$('#orgcats').querySelectorAll('[data-chips]')].map(el => new Sortable(el, {
    group:'cats', animation:120, forceFallback:true, fallbackTolerance:3, emptyInsertThreshold:24,
    onStart: () => $('#orgcats').classList.add('dragging'),
    onMove: evt => { mark(evt.to); },
    onEnd: evt => {
      mark(null); $('#orgcats').classList.remove('dragging');
      const made = evt.to.dataset.chips === 'new';
      readPlan();
      if(made){ setTimeout(showPlan, 0); return; } // rebuild after Sortable finishes this drop
      $('#orgcats').querySelectorAll('.cat:not(.new)').forEach((c,i) => { c.querySelector('.cat-head span').textContent = orgGroups[i].ids.length; });
      planSummary();
    },
  }));
  $('#orgstep1').hidden = true; $('#orgstep2').hidden = false;
}
$('#organize').onclick = showOrganize;
$('#orgcancel').onclick = () => $('#orgdlg').close();
$('#orggo').onclick = suggestCategories;
$('#orgback').onclick = () => { $('#orgstep1').hidden = false; $('#orgstep2').hidden = true; };
$('#orgagain').onclick = async () => { $('#orgagain').innerHTML = '<span class="spin"></span> Trying again…'; await suggestCategories(); $('#orgagain').textContent = 'Try again'; };
$('#orgapply').onclick = () => {
  const mode = document.querySelector('input[name=orgmode]:checked').value;
  $('#orgdlg').close();
  arrangeByCategory(orgGroups.filter(g => g.ids.length), mode, $('#orgfolders').checked);
};
$('#orgaiset').onclick = () => { $('#orgdlg').close(); showSettings('ai'); };

// ---------- settings: AI ----------
let setState = null;   // from aiSettings
let setFound = {};     // CLI id -> {installed, version, error}
let setCur = 'page:license'; // what Settings shows: 'page:license|backups|help' or 'ai'
let aiSel = null;     // on the AI page, the option shown below the list ('' for No AI)
let setReturn = false; // reopen Organize after closing
let setModels = {};    // provider id -> {models:[{id,name}], from, note} or {loading:true}
const SET_PAGES = {license: loadLicense, backups: loadBackups, help: loadHelp};
/** target: 'page:license' and so on, 'ai' for the AI in use (and back to Organize after), or nothing for where it was. */
async function showSettings(target){
  setReturn = target === 'ai';
  setState = await api('aiSettings');
  if(target) setCur = target;
  if(aiSel === null || target === 'ai') aiSel = setState.active || '';
  renderSettings(); openPage();
  // Opening a dialog focuses its first button, which would look like a second selected row.
  if(!$('#setdlg').open){ $('#setdlg').showModal(); if(setCur !== 'page:license' || lic.licensed) document.activeElement?.blur(); }
  detectAI();
}
function openPage(){
  const load = setCur.startsWith('page:') && SET_PAGES[setCur.slice(5)];
  if(load) Promise.resolve(load()).catch(e => toast(e.message, 'err'));
}
async function detectAI(){
  setFound = Object.fromEntries(setState.providers.filter(p => p.kind === 'cli').map(p => [p.id, {...(setFound[p.id] || {}), checking:true}]));
  renderSettings();
  setFound = await api('aiDetect').catch(() => ({}));
  renderSettings();
}
/** Ready means it can be used right now: installed, or with its key (or server) set up. */
function aiReady(p){
  if(p.kind === 'cli'){ const f = setFound[p.id]; return f ? (f.checking && !('installed' in f) ? null : !!f.installed) : null; }
  return p.keyOptional ? !!p.model : p.hasKey;
}
function aiStatus(p){
  if(p.kind === 'cli'){ const f = setFound[p.id] || {}; return f.checking && !('installed' in f) ? 'Checking…' : f.installed ? 'On this computer' : 'Not installed'; }
  if(p.keyOptional) return p.model ? 'Set up' : 'Needs a server and model';
  return p.hasKey ? `Key saved ${p.keyHint}` : 'Needs an API key';
}
function renderSettings(){
  document.querySelectorAll('#setdlg .prov').forEach(b => {
    b.classList.toggle('cur', b.dataset.prov === setCur);
    b.onclick = () => { setCur = b.dataset.prov; renderSettings(); openPage(); };
  });
  const page = setCur.startsWith('page:') ? setCur.slice(5) : null;
  Object.keys(SET_PAGES).forEach(n => { $('#page-' + n).hidden = page !== n; });
  $('#setbody').hidden = !!page;
  if(page) return;
  const body = $('#setbody');
  const keepFilter = $('#mfilter') ? $('#mfilter').value : '';
  const opt = (id, name, status, ready) => `<button class="opt${setState.active === id || (!id && !setState.active) ? ' on' : ''}${aiSel === id ? ' cur' : ''}${ready === false ? ' off' : ''}" data-ai="${id}"><span class="radio"></span><span class="nm">${esc(name)}</span><span class="st">${esc(status)}</span></button>`;
  const provs = setState.providers;
  const ready = provs.filter(p => aiReady(p) !== false);
  const setup = provs.filter(p => aiReady(p) === false);
  body.innerHTML = `<div class="set-head"><div><h3>AI for organizing</h3><p class="hint" style="margin:4px 0 0;font-size:13px">Organize by category can ask an AI for groups like Kids or Work, and follow what you tell it. Without one, apps are grouped by App Store category.</p></div><button class="btn small" id="setclose" style="margin-left:auto">Done</button></div>
    <div class="opts">
      <div class="opt-label">Ready to use</div>
      ${opt('', 'No AI', 'App Store categories', true)}
      ${ready.map(p => opt(p.id, p.name, aiStatus(p), aiReady(p))).join('')}
      ${setup.length ? `<div class="opt-label">Needs setup<span class="spacer"></span><button class="btn small" id="setdetect" style="text-transform:none;letter-spacing:0;font-weight:400">Look again</button></div>${setup.map(p => opt(p.id, p.name, aiStatus(p), false)).join('')}` : ''}
    </div>
    <div class="detail" id="aidetail"></div>`;
  body.querySelectorAll('.opt').forEach(b => b.onclick = async () => {
    aiSel = b.dataset.ai;
    // Picking an option that's ready makes it the one in use, like a radio button.
    const p = provs.find(x => x.id === aiSel);
    const isReady = !aiSel || (p && aiReady(p));
    try{
      if(isReady && aiSel !== (setState.active || '')){
        setState = aiSel ? await api('aiSave', {id: aiSel, active: true}) : await api('aiSave', {id: setState.active, active: false});
        refreshAIActive();
      }
    }catch(e){ /* shown below */ }
    renderSettings();
  });
  if($('#setdetect')) $('#setdetect').onclick = detectAI;
  $('#setclose').onclick = () => $('#setdlg').close();
  const d = $('#aidetail');
  if(aiSel === ''){
    d.innerHTML = `<h4>No AI</h4><p style="margin:0">Apps are grouped by their App Store category, such as Games, Productivity and Social Networking. It's free and needs no setup.</p>`;
    return;
  }
  const p = provs.find(x => x.id === aiSel);
  if(!p){ aiSel = ''; return renderSettings(); }
  const f = setFound[p.id] || {};
  const inUse = setState.active === p.id;
  const isReady = aiReady(p);
  d.innerHTML = `<div class="row"><h4>${esc(p.name)}</h4>${p.kind === 'cli' && f.installed ? `<span class="badge ok">✓ ${esc(f.version || 'Installed')}</span>` : ''}${p.hasKey ? `<span class="badge ok">✓ Key saved ${esc(p.keyHint)}</span>` : ''}${inUse ? '<span class="badge on">In use</span>' : ''}</div>
    <p class="hint" style="margin:0;font-size:13px">${esc(p.blurb)}${p.site ? ` <a href="${esc(p.site)}" target="_blank">${p.kind === 'api' ? 'Get a key' : 'Learn more'}</a>` : ''}</p>
    ${p.kind === 'cli' && isReady === false ? `<p style="margin:0">Install ${esc(p.name)} and sign in to it, then press <b>Look again</b>.${f.error ? ` <span class="hint mono">${esc(f.error)}</span>` : ''}</p>` : ''}
    ${p.customUrl ? `<div class="field"><label for="seturl">Server address</label><input id="seturl" class="mono" value="${esc(p.baseUrl)}" placeholder="http://localhost:11434/v1"></div>` : ''}
    ${p.kind === 'api' ? `<div class="field"><label for="setkey">API key${p.keyOptional ? ' <span class="hint" style="font-weight:400">(if the server needs one)</span>' : ''}</label>
      <div class="row" style="flex-wrap:nowrap"><input id="setkey" type="password" class="mono" autocomplete="off" spellcheck="false" placeholder="${p.hasKey ? `Saved (${esc(p.keyHint)}). Paste a new key to replace it.` : 'Paste your key'}">${p.hasKey ? '<button class="btn small" id="setkeydel">Remove</button>' : ''}</div>
      <span class="hint" style="margin:0">${p.encrypted ? 'Stored on this computer, encrypted with your system keychain.' : 'Stored on this computer in a plain settings file, because this system has no keychain to encrypt it with.'}</span></div>` : ''}
    ${isReady !== false || p.kind === 'api' ? `<div class="models">
      <div class="models-head"><b>Model</b><span class="hint" id="mcount" style="margin:0"></span><span class="spacer"></span>
        <input id="mfilter" placeholder="Filter, or type a model ID" autocomplete="off" spellcheck="false"><button class="btn small" id="mrefresh" title="Ask ${esc(p.name)} for its models again">Refresh</button></div>
      <div class="mlist" id="mlist"></div>
    </div>` : ''}
    <div class="row"><button class="btn" id="settest"${isReady === false && p.kind === 'cli' ? ' disabled' : ''}>Test</button>${inUse ? '' : `<button class="btn primary" id="setuse"${isReady === false && p.kind === 'cli' ? ' disabled' : ''}>Use for organizing</button>`}<span id="setmsg" class="hint" style="margin:0"></span></div>
    ${p.kind === 'cli' ? `<p class="hint" style="margin:0">Runs <span class="mono">${esc(p.command)}</span> with tools turned off, in an empty folder. Only app names and their App Store categories are sent, when you press Suggest categories.</p>` : '<p class="hint" style="margin:0">Only app names and their App Store categories are sent, when you press Suggest categories.</p>'}`;
  if($('#mfilter')) $('#mfilter').value = keepFilter;
  bindSettings();
}
/** Saves what's typed in the form for the provider shown. */
async function saveForm(extra = {}){
  const body = {id: aiSel, ...extra};
  if($('#seturl')) body.baseUrl = $('#seturl').value;
  if($('#setkey') && $('#setkey').value.trim()) body.apiKey = $('#setkey').value;
  setState = await api('aiSave', body);
}
function setMsg(text, kind){ const m = $('#setmsg'); if(m){ m.textContent = text; m.className = 'hint ' + (kind === 'ok' ? 'ok-text' : kind === 'err' ? 'err-text' : ''); } }
function bindSettings(){
  const use = $('#setuse');
  if(use) use.onclick = async () => {
    try{
      await saveForm({active: true});
      renderSettings(); refreshAIActive();
    }catch(e){ setMsg(e.message, 'err'); }
  };
  if($('#settest')) $('#settest').onclick = async () => {
    const b = $('#settest'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Testing…'; setMsg('');
    try{ await saveForm(); const r = await api('aiTest', {id: aiSel}); renderSettings(); setMsg(`Works. It answered in ${r.seconds} seconds.`, 'ok'); }
    catch(e){ renderSettings(); setMsg(e.message, 'err'); }
  };
  if($('#mlist')){
    $('#mfilter').oninput = renderModelList;
    $('#mrefresh').onclick = () => loadModels(aiSel, true);
    $('#mlist').onclick = async e => {
      const row = e.target.closest('[data-model]'); if(!row) return;
      try{ setState = await api('aiSave', {id: aiSel, model: row.dataset.model}); renderModelList(); refreshAIActive(); }
      catch(err){ setMsg(err.message, 'err'); }
    };
    loadModels(aiSel);
  }
  if($('#setkeydel')) $('#setkeydel').onclick = async () => { setState = await api('aiSave', {id: aiSel, apiKey: ''}); renderSettings(); refreshAIActive(); };
  // A new key or server address can change which models there are.
  ['#seturl','#setkey'].forEach(s => { const el = $(s); if(el) el.onchange = () => saveForm().then(() => { delete setModels[aiSel]; renderSettings(); if(s === '#setkey') setMsg('Key saved.', 'ok'); }).catch(e => setMsg(e.message, 'err')); });
}
/** Asks the tool or API for its models, once per provider unless refreshed. */
async function loadModels(id, force){
  if(!force && setModels[id]) return renderModelList();
  setModels[id] = {loading:true}; renderModelList();
  try{ setModels[id] = await api('aiModels', {id}); }
  catch(e){ setModels[id] = {models:[], from:'builtin', note:e.message}; }
  if(aiSel === id) renderModelList();
}
function renderModelList(){
  const el = $('#mlist'); if(!el) return;
  const p = setState.providers.find(x => x.id === aiSel);
  const m = setModels[aiSel] || {loading:true};
  const q = ($('#mfilter').value || '').trim();
  if(m.loading){ el.innerHTML = `<div class="mnote"><span class="spin"></span> Asking ${esc(p.name)} for its models…</div>`; $('#mcount').textContent = ''; return; }
  const all = m.models || [];
  const ql = q.toLowerCase();
  const shown = all.filter(x => !ql || x.id.toLowerCase().includes(ql) || x.name.toLowerCase().includes(ql));
  $('#mcount').textContent = `${all.length} ${m.from === 'live' ? `from ${p.kind === 'cli' ? p.name : 'the API'}` : 'built in'}`;
  const row = (id, name, sub) => `<button class="mrow${p.model === id ? ' on' : ''}" data-model="${esc(id)}"><span><b>${esc(name)}</b>${sub ? `<span class="mono">${esc(sub)}</span>` : ''}</span>${p.model === id ? '<span class="badge on">✓ Selected</span>' : ''}</button>`;
  let html = '';
  if(m.note) html += `<div class="mnote">${m.from === 'builtin' && all.length ? 'Showing the built-in list. ' : ''}${esc(m.note)}</div>`;
  if(p.kind === 'cli' && !ql) html += row('', `${p.name}'s default`, 'whatever model it is set to use');
  // The saved model, or a typed ID, may not be in the list; offer it anyway.
  if(p.model && !all.some(x => x.id === p.model) && (!ql || p.model.toLowerCase().includes(ql))) html += row(p.model, p.model, 'not in the list');
  if(q && !all.some(x => x.id === q) && q !== p.model) html += row(q, `Use “${q}”`, 'a model ID you typed');
  html += shown.slice(0, 300).map(x => row(x.id, x.name, x.name !== x.id ? x.id : '')).join('');
  if(shown.length > 300) html += `<div class="mnote">${shown.length - 300} more. Type to narrow the list.</div>`;
  if(!html) html = `<div class="mnote">No models match. Type a model ID to use it anyway.</div>`;
  el.innerHTML = html;
}
$('#setbtn').onclick = () => showSettings();
document.querySelectorAll('#setdlg .setdone').forEach(b => b.onclick = () => $('#setdlg').close());
$('#setdlg').addEventListener('close', () => { refreshAIActive(); if(setReturn){ setReturn = false; if(S) showOrganize(); } });

// ---------- help & terms ----------
window.addEventListener('error', e => api('logError', {message: e.message, stack: e.error && e.error.stack}).catch(() => {}));
window.addEventListener('unhandledrejection', e => api('logError', {message: String(e.reason && e.reason.message || e.reason), stack: e.reason && e.reason.stack}).catch(() => {}));
function showHelp(){ showSettings('page:help'); }
async function loadHelp(){
  const n = await api('errorCount').catch(() => 0);
  $('#errcount').textContent = n ? `${n} recent error${n===1?'':'s'} from the app, with your app and system versions.` : 'No errors recorded. Sends your app and system versions.';
  $('#clearerrs').hidden = !n;
}
document.querySelectorAll('[data-help]').forEach(b => b.onclick = () => api('help', {kind: b.dataset.help}).catch(e => toast(e.message, 'err')));
$('#clearerrs').onclick = async () => { await api('clearErrors'); loadHelp(); };
// TERMS.md is the single source: "## " starts a section, blank lines separate paragraphs.
function termsHTML(md){
  return md.split(/\n\s*\n/).map(b => b.trim()).filter(b => b && !b.startsWith('# '))
    .map(b => b.startsWith('## ') ? `<h4>${esc(b.slice(3))}</h4>` : `<p>${esc(b.replace(/\n/g, ' '))}</p>`).join('');
}
async function showTerms(mustAgree){
  const t = await api('terms');
  $('#termstext').innerHTML = termsHTML(t.text);
  $('#termsask').hidden = $('#termsfirst').hidden = !mustAgree;
  $('#termslater').hidden = !!mustAgree;
  $('#termsdlg').showModal();
  $('#termstext').scrollTop = 0;
}
$('#helpterms').onclick = () => showTerms(false);
$('#termsclose').onclick = () => $('#termsdlg').close();
$('#termsagree').onclick = async () => { await api('acceptTerms'); $('#termsdlg').close(); };
$('#termsquit').onclick = () => api('quit');
// Until the terms are accepted, Escape must not dismiss them.
$('#termsdlg').addEventListener('cancel', e => { if(!$('#termsfirst').hidden) e.preventDefault(); });
window.organizer.onShow(what => {
  if(what === 'terms' && !$('#termsdlg').open) showTerms(false);
  if(what === 'checkUpdates') checkUpdates();
  if(what === 'settings' && !$('#termsdlg').open) showSettings();
});

// ---------- updates ----------
let updateAsked = false; // the person asked, so say how the check turned out
let updateNoted = null;   // version we've already told them about
function showUpdate(u){
  const msg = {
    checking: 'Checking for updates…',
    downloading: `Downloading Arrange ${u.version}… ${u.percent || 0}%`,
    ready: `Arrange ${u.version} is ready. Restart to update.`,
    current: 'You have the latest version.',
    error: u.message,
    dev: 'Updates are only available in the installed app.',
    unsupported: 'Automatic updates aren\'t available here yet. Download the newest version from the Arrange website.',
  }[u.state];
  if(msg) $('#updstatus').textContent = msg;
  $('#navupd').textContent = u.state === 'ready' ? 'UPDATE' : '';
  $('#updbtn').hidden = u.state !== 'ready';
  if(u.state === 'ready') $('#updbtn').textContent = `Restart to Update to ${u.version}`;
  if(u.state === 'ready' && updateNoted !== u.version){
    updateNoted = u.version; updateAsked = false;
    $('#updnotetext').textContent = `Version ${u.version} has downloaded. Restart Arrange to start using it, or it will install the next time you quit.`;
    $('#updnote').hidden = false;
  }
  if(updateAsked && ['current','error','dev','unsupported'].includes(u.state)){ updateAsked = false; toast(msg, u.state === 'error' ? 'err' : 'ok'); }
  else if(updateAsked && u.state === 'downloading' && !u.percent) toast(msg);
}
async function checkUpdates(){
  updateAsked = true;
  try{ showUpdate(await api('checkUpdates')); }catch(e){ updateAsked = false; toast(e.message, 'err'); }
}
$('#updcheck').onclick = checkUpdates;
$('#updlater').onclick = () => { $('#updnote').hidden = true; };
$('#updnow').onclick = $('#updbtn').onclick = async () => {
  if(dirty && !confirm('Restart to update? Changes you haven\'t applied will be lost.')) return;
  // Cleared first so the restart isn't held up by the unsaved-changes guard; put back if it doesn't restart.
  const wasDirty = dirty; dirty = false;
  const r = await api('installUpdate').catch(() => null);
  if(!r || !r.ok){ dirty = wasDirty; toast('The update isn\'t ready to install yet. Try again in a moment.', 'err'); }
};
window.organizer.onUpdate(showUpdate);
api('update').then(showUpdate).catch(() => {});
api('terms').then(t => { if(!t.accepted) showTerms(true); }).catch(() => {});

resetProfile();
if(typeof Sortable === 'undefined') toast('Could not load the drag-and-drop library.', 'err', 20000);
scan();
