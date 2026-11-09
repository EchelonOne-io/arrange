'use strict';
// Minimal, lossless binary property list (bplist00) reader/writer.
//
// Why our own: JavaScript Dates only hold milliseconds, but SpringBoard stores
// timestamps with sub-millisecond precision, and recent iPadOS versions reject
// layouts whose timestamps were rounded. Dates are kept here as raw seconds
// since 2001-01-01 (PDate), and reals as PReal, so a layout read from the iPad
// is written back bit-for-bit.

class PDate {
  constructor(secs) { this.secs = secs; } // seconds since 2001-01-01T00:00:00Z
  static fromDate(d) { return new PDate(d.getTime() / 1000 - 978307200); }
  toDate() { return new Date((this.secs + 978307200) * 1000); }
}
class PReal {
  constructor(value, size = 8) { this.value = value; this.size = size; }
}
class PUid {
  constructor(value) { this.value = value; }
}

// ---------------------------------------------------------------- reading

function parse(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.toString('latin1', 0, 6) !== 'bplist') throw new Error('Not a binary plist');
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableOff = Number(buf.readBigUInt64BE(t + 24));

  const readUInt = (pos, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    return v;
  };
  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = readUInt(tableOff + i * offSize, offSize);

  const cache = new Map();
  const depth = new Set();

  function lenAndStart(pos, info) {
    if (info !== 0xf) return [info, pos + 1];
    const marker = buf[pos + 1];
    if ((marker & 0xf0) !== 0x10) throw new Error('Bad length marker');
    const size = 1 << (marker & 0xf);
    return [readUInt(pos + 2, size), pos + 2 + size];
  }

  function obj(ref) {
    if (cache.has(ref)) return cache.get(ref);
    if (depth.has(ref)) throw new Error('Cyclic plist');
    depth.add(ref);
    const pos = offsets[ref];
    const marker = buf[pos];
    const type = marker >> 4;
    const info = marker & 0xf;
    let v;
    switch (type) {
      case 0x0:
        v = info === 0x8 ? false : info === 0x9 ? true : null;
        break;
      case 0x1: {
        const size = 1 << info;
        if (size === 8) {
          const b = buf.readBigInt64BE(pos + 1);
          v = b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
        } else if (size === 16) {
          const b = buf.readBigInt64BE(pos + 9);
          v = b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
        } else v = readUInt(pos + 1, size);
        break;
      }
      case 0x2:
        v = info === 2 ? new PReal(buf.readFloatBE(pos + 1), 4) : new PReal(buf.readDoubleBE(pos + 1), 8);
        break;
      case 0x3:
        v = new PDate(buf.readDoubleBE(pos + 1));
        break;
      case 0x4: {
        const [n, s] = lenAndStart(pos, info);
        v = Buffer.from(buf.subarray(s, s + n));
        break;
      }
      case 0x5: {
        const [n, s] = lenAndStart(pos, info);
        v = buf.toString('latin1', s, s + n);
        break;
      }
      case 0x6: {
        const [n, s] = lenAndStart(pos, info);
        const b = Buffer.from(buf.subarray(s, s + n * 2));
        b.swap16();
        v = b.toString('utf16le');
        break;
      }
      case 0x8:
        v = new PUid(readUInt(pos + 1, info + 1));
        break;
      case 0xa:
      case 0xc: {
        const [n, s] = lenAndStart(pos, info);
        v = [];
        for (let i = 0; i < n; i++) v.push(obj(readUInt(s + i * refSize, refSize)));
        break;
      }
      case 0xd: {
        const [n, s] = lenAndStart(pos, info);
        v = {};
        for (let i = 0; i < n; i++) {
          const k = obj(readUInt(s + i * refSize, refSize));
          v[k] = obj(readUInt(s + (n + i) * refSize, refSize));
        }
        break;
      }
      default:
        throw new Error(`Unsupported plist object type 0x${marker.toString(16)}`);
    }
    depth.delete(ref);
    cache.set(ref, v);
    return v;
  }
  return obj(top);
}

// ---------------------------------------------------------------- writing

function build(root) {
  const objects = []; // encoded Buffers (without refs resolved for containers)
  const specs = []; // {kind, children} for containers

  function add(value) {
    const idx = objects.length;
    objects.push(null);
    specs.push(null);
    if (Array.isArray(value)) {
      specs[idx] = { kind: 'array', children: value.map(add) };
    } else if (isPlainObject(value)) {
      const keys = Object.keys(value);
      const k = keys.map(add);
      const v = keys.map((key) => add(value[key]));
      specs[idx] = { kind: 'dict', keys: k, values: v };
    } else {
      objects[idx] = encodeScalar(value);
    }
    return idx;
  }
  add(root);

  const n = objects.length;
  const refSize = n < 256 ? 1 : n < 65536 ? 2 : 4;
  const writeRef = (b, pos, r) => { if (refSize === 1) b.writeUInt8(r, pos); else if (refSize === 2) b.writeUInt16BE(r, pos); else b.writeUInt32BE(r, pos); };

  for (let i = 0; i < n; i++) {
    const s = specs[i];
    if (!s) continue;
    if (s.kind === 'array') {
      const head = lengthHeader(0xa, s.children.length);
      const body = Buffer.alloc(s.children.length * refSize);
      s.children.forEach((r, j) => writeRef(body, j * refSize, r));
      objects[i] = Buffer.concat([head, body]);
    } else {
      const cnt = s.keys.length;
      const head = lengthHeader(0xd, cnt);
      const body = Buffer.alloc(cnt * 2 * refSize);
      s.keys.forEach((r, j) => writeRef(body, j * refSize, r));
      s.values.forEach((r, j) => writeRef(body, (cnt + j) * refSize, r));
      objects[i] = Buffer.concat([head, body]);
    }
  }

  const header = Buffer.from('bplist00', 'latin1');
  const offsets = [];
  let pos = header.length;
  for (const o of objects) { offsets.push(pos); pos += o.length; }
  const tableOff = pos;
  const offSize = tableOff < 256 ? 1 : tableOff < 65536 ? 2 : tableOff < 2 ** 32 ? 4 : 8;
  const table = Buffer.alloc(n * offSize);
  offsets.forEach((o, i) => {
    if (offSize === 8) table.writeBigUInt64BE(BigInt(o), i * 8);
    else table.writeUIntBE(o, i * offSize, offSize);
  });
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(n), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(tableOff), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof PDate) && !(v instanceof PReal)
    && !(v instanceof PUid) && !(v instanceof Date) && !(v instanceof Uint8Array);
}

function lengthHeader(type, len) {
  if (len < 15) return Buffer.from([(type << 4) | len]);
  return Buffer.concat([Buffer.from([(type << 4) | 0xf]), encodeInt(len)]);
}

function encodeInt(v) {
  if (typeof v === 'bigint') {
    const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(v, 1); return b;
  }
  if (v >= 0 && v < 256) return Buffer.from([0x10, v]);
  if (v >= 0 && v < 65536) { const b = Buffer.alloc(3); b[0] = 0x11; b.writeUInt16BE(v, 1); return b; }
  if (v >= 0 && v < 2 ** 32) { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(v, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt(v), 1); return b;
}

function encodeScalar(v) {
  if (v === null || v === undefined) return Buffer.from([0x00]);
  if (v === false) return Buffer.from([0x08]);
  if (v === true) return Buffer.from([0x09]);
  if (typeof v === 'bigint') return encodeInt(v);
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return encodeInt(v);
    const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v, 1); return b;
  }
  if (v instanceof PReal) {
    if (v.size === 4) { const b = Buffer.alloc(5); b[0] = 0x22; b.writeFloatBE(v.value, 1); return b; }
    const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v.value, 1); return b;
  }
  if (v instanceof PDate || v instanceof Date) {
    const secs = v instanceof PDate ? v.secs : PDate.fromDate(v).secs;
    const b = Buffer.alloc(9); b[0] = 0x33; b.writeDoubleBE(secs, 1); return b;
  }
  if (v instanceof PUid) {
    const size = v.value < 256 ? 1 : v.value < 65536 ? 2 : 4;
    const b = Buffer.alloc(1 + size); b[0] = 0x80 | (size - 1); b.writeUIntBE(v.value, 1, size); return b;
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const data = Buffer.from(v);
    return Buffer.concat([lengthHeader(0x4, data.length), data]);
  }
  if (typeof v === 'string') {
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(v)) return Buffer.concat([lengthHeader(0x5, v.length), Buffer.from(v, 'latin1')]);
    const b = Buffer.from(v, 'utf16le'); b.swap16();
    return Buffer.concat([lengthHeader(0x6, b.length / 2), b]);
  }
  throw new Error(`Cannot write ${typeof v} to a plist`);
}

module.exports = { parse, build, PDate, PReal, PUid };
