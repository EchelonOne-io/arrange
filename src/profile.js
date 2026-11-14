'use strict';
// What the Home Screen looks like on each kind of device. Picked from the
// device's ProductType (for example "iPhone17,1" or "iPad14,3").

const PROFILES = {
  ipad: { kind: 'ipad', label: 'iPad', os: 'iPadOS', cols: 6, rows: 5, dockMax: null },
  iphone: { kind: 'iphone', label: 'iPhone', os: 'iOS', cols: 4, rows: 6, dockMax: 4 },
};

function profileFor(model) {
  const m = String(model || '');
  // iPod touch has the same Home Screen as an iPhone.
  const p = /^(iPhone|iPod)/i.test(m) ? PROFILES.iphone : PROFILES.ipad;
  return { ...p, cells: p.cols * p.rows };
}

module.exports = { profileFor };
