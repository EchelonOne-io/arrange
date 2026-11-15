// Home Screen shape of the open device; the backend sends the real one on load.
const DEFAULT_PROFILE = {kind:'ipad', label:'iPad', os:'iPadOS', cols:6, rows:5, cells:30, dockMax:null};
let profile = DEFAULT_PROFILE;
const WIDGET_CELLS = {icon:1, small:4, medium:8, large:16, extralarge:24};
const $ = s => document.querySelector(s);

let nodes = {};      // uid -> {uid, kind, name, id, icon, size, pages:[[uid]] (folders)}
let S = null;        // {dock:[uid], pages:[[uid]], shelf:[uid], hidden:[uid]}
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
    S = { dock: ingest(r.tree.dock), pages: r.tree.pages.map(p => ingest(p)), shelf: [], hidden: ingest(r.tree.library || []) };
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
    html += `<section class="page"><div class="page-head"><b>Page ${i+1}</b><span class="${over?'full':''}">${p.length} item${p.length===1?'':'s'}${over?` · more than fits, ${profile.os} will spill the rest to the next page`:''}</span><span class="spacer"></span>
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
  ['#apply','#sortall','#addpage'].forEach(s => $(s).disabled = !loaded);
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
  $('#licbtn').textContent = l.licensed ? 'License' : 'Buy / Enter key';
  $('#licon').hidden = !l.licensed; $('#licoff').hidden = l.licensed;
  $('#lictitle').textContent = l.licensed ? 'License' : 'Unlock Arrange';
  $('#licshown').textContent = l.displayKey ? ` (key ${l.displayKey})` : '';
  $('#licerr').hidden = $('#licerr2').hidden = true;
}
function showLicense(){ setLicense(lic); $('#lickey').value = ''; $('#licdlg').showModal(); if(!lic.licensed) $('#lickey').focus(); }
async function busy(btn, label, fn, errEl){
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try{ await fn(); }
  catch(e){ errEl.textContent = e.message; errEl.hidden = false; }
  finally{ btn.disabled = false; btn.textContent = old; }
}
$('#licbtn').onclick = showLicense;
$('#licclose').onclick = $('#licdone').onclick = () => $('#licdlg').close();
$('#licbuy').onclick = () => { if(lic.buyUrl) window.open(lic.buyUrl); };
$('#licgo').onclick = () => busy($('#licgo'), 'Activating…', async () => {
  setLicense(await api('activate', {key: $('#lickey').value}));
  $('#licdlg').close(); toast('Activated. You can apply layouts to your devices now.', 'ok');
}, $('#licerr'));
$('#lickey').onkeydown = e => { if(e.key === 'Enter') $('#licgo').click(); };
$('#licdeact').onclick = () => busy($('#licdeact'), 'Deactivating…', async () => {
  setLicense(await api('deactivate')); toast('Deactivated on this computer.', 'ok');
}, $('#licerr2'));
api('license').then(l => { setLicense(l); if(l.revoked) toast('Your license key is no longer valid, so applying to a device is locked again.', 'err', 12000); }).catch(() => {});

async function showBackups(){
  const r = await api('backups');
  $('#bkfolder').textContent = `Saved in ${r.folder}`;
  $('#bklist').innerHTML = (r.backups||[]).map(b => `<div class="bk"><span class="mono">${esc(b.file)}</span><button class="btn small" data-file="${esc(b.file)}">Restore</button></div>`).join('') || '<p class="hint">No backups yet.</p>';
  $('#bklist').querySelectorAll('button').forEach(b => b.onclick = async () => {
    if(!confirm(`Put this saved layout back on the ${device ? profile.label : NEUTRAL}? Your current layout is backed up first.`)) return;
    try{ await api('restore', {file: b.dataset.file}); bkdlg.close(); toast('Restored. Reloading…', 'ok'); setTimeout(() => load(device?.udid), 1200); }
    catch(e){ toast(e.message, 'err', 10000); }
  });
  bkdlg.showModal();
}

// ---------- events ----------
document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if(act){
    const i = +act.dataset.i; pushUndo();
    if(act.dataset.act === 'sortpage') S.pages[i] = sortList(S.pages[i]);
    if(act.dataset.act === 'delpage') S.pages.splice(i, 1);
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
$('#bkclose').onclick = () => bkdlg.close();
// keep looking while nothing is open, so plugging in "just works"
setInterval(() => { if(!S && !document.hidden && !scanning) scan(true); }, 3000);
$('#apply').onclick = apply;
$('#backups').onclick = showBackups;
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

resetProfile();
if(typeof Sortable === 'undefined') toast('Could not load the drag-and-drop library.', 'err', 20000);
scan();
