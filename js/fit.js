// A small FIT decoder and encoder. The decoder reads the messages GPX Merge needs
// (file id, sport, activity and the per-second records) and skips everything else.
// Unfinished files from a device that died mid-ride are read up to where they stop.
// No dependencies, so it runs in the browser (window.FIT) and in Node (require).
(function (root) {
  'use strict';

  const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z, the FIT clock's zero, in Unix seconds
  const SEMICIRCLE = 180 / 2 ** 31;

  // A few manufacturer ids from the FIT profile, for the "recorded with" label.
  const MAKERS = {
    1: 'Garmin', 23: 'Suunto', 32: 'Wahoo', 69: 'Stages', 89: 'Tacx', 123: 'Polar', 260: 'Zwift',
    263: 'Favero', 265: 'Strava', 267: 'Bryton', 268: 'SRAM', 289: 'Hammerhead', 294: 'COROS',
  };
  const SPORTS = { 1: 'running', 2: 'cycling', 11: 'walking', 17: 'hiking' };
  // Byte size of each base type, indexed by base type number.
  const SIZES = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];

  const MSG = { fileId: 0, sport: 12, session: 18, record: 20, activity: 34 };
  const utf8 = new TextDecoder();

  function isFIT(u8, at = 0) {
    return u8.length >= at + 12 && (u8[at] === 12 || u8[at] === 14) &&
      u8[at + 8] === 0x2e && u8[at + 9] === 0x46 && u8[at + 10] === 0x49 && u8[at + 11] === 0x54; // ".FIT"
  }

  // One field value, or null for FIT's "invalid" marker. Arrays give their first element.
  function readValue(view, u8, p, type, size, le) {
    if (type >= SIZES.length || size < SIZES[type]) return null;
    let v;
    switch (type) {
      case 0: case 2: case 13: v = u8[p]; return v === 0xff ? null : v; // enum, uint8, byte
      case 10: return u8[p] || null; // uint8z
      case 1: v = view.getInt8(p); return v === 0x7f ? null : v;
      case 3: v = view.getInt16(p, le); return v === 0x7fff ? null : v;
      case 4: v = view.getUint16(p, le); return v === 0xffff ? null : v;
      case 11: return view.getUint16(p, le) || null; // uint16z
      case 5: v = view.getInt32(p, le); return v === 0x7fffffff ? null : v;
      case 6: v = view.getUint32(p, le); return v === 0xffffffff ? null : v;
      case 12: return view.getUint32(p, le) || null; // uint32z
      case 8: v = view.getFloat32(p, le); return isFinite(v) ? v : null;
      case 9: v = view.getFloat64(p, le); return isFinite(v) ? v : null;
      case 7: { // null-terminated string
        let e = p;
        while (e < p + size && u8[e] !== 0) e++;
        return e > p ? utf8.decode(u8.subarray(p, e)) : null;
      }
      default: return null; // 64-bit integers: nothing here needs them
    }
  }

  function readMessages(u8, view, pos, end, out) {
    const defs = [];
    let lastTime = null;
    while (pos < end) {
      const h = u8[pos++];
      let local, timeOffset = null;
      if (h & 0x80) {
        // Compressed timestamp header: a data message whose time is a 5-bit offset from the last one.
        local = (h >> 5) & 3;
        timeOffset = h & 0x1f;
      } else if (h & 0x40) {
        // Definition message: describes the layout of later data messages for this local type.
        if (pos + 5 > end) break;
        const le = u8[pos + 1] === 0;
        const global = view.getUint16(pos + 2, le);
        const n = u8[pos + 4];
        pos += 5;
        if (pos + n * 3 > end) break;
        const fields = [];
        let size = 0;
        for (let i = 0; i < n; i++, pos += 3) { fields.push([u8[pos], u8[pos + 1], u8[pos + 2] & 0x1f]); size += u8[pos + 1]; }
        if (h & 0x20) { // developer fields: only their size matters here
          const nd = u8[pos++];
          for (let i = 0; i < nd; i++, pos += 3) size += u8[pos + 1];
        }
        defs[h & 0x0f] = { global, le, fields, size };
        continue;
      } else {
        local = h & 0x0f;
      }

      const def = defs[local];
      if (!def || pos + def.size > end) break; // corrupt or cut off: keep what was read so far
      const msg = {};
      let p = pos;
      for (const [num, size, type] of def.fields) {
        const v = readValue(view, u8, p, type, size, def.le);
        if (v != null) msg[num] = v;
        p += size;
      }
      pos += def.size;

      if (msg[253] != null) lastTime = msg[253];
      else if (timeOffset != null && lastTime != null) {
        const low = lastTime % 32;
        lastTime = lastTime - low + timeOffset + (timeOffset < low ? 32 : 0);
        msg[253] = lastTime;
      }
      take(def.global, msg, out);
      if (out.messages) out.messages.push({ global: def.global, fields: msg });
    }
  }

  function take(global, m, out) {
    if (global === MSG.record) {
      if (m[253] == null) return;
      const r = { t: m[253] + FIT_EPOCH };
      // No fix is written as "invalid"; a few devices write 0, 0 instead.
      if (m[0] != null && m[1] != null && (m[0] || m[1])) { r.lat = m[0] * SEMICIRCLE; r.lon = m[1] * SEMICIRCLE; }
      const alt = m[78] != null ? m[78] : m[2]; // enhanced_altitude, then altitude: both metres * 5 + 500
      if (alt != null) r.ele = Math.round((alt / 5 - 500) * 10) / 10;
      if (m[7] != null) r.power = m[7];
      if (m[3] != null) r.hr = m[3];
      if (m[4] != null) r.cad = m[4];
      if (m[13] != null) r.atemp = m[13];
      out.records.push(r);
    } else if (global === MSG.fileId) {
      if (out.manufacturer == null) {
        out.manufacturer = m[1] != null ? m[1] : null;
        out.product = m[2] != null ? m[2] : null;
        out.productName = typeof m[8] === 'string' ? m[8].trim() : '';
      }
    } else if (global === MSG.session) {
      if (m[5] != null) out.sport = m[5];
      if (m[6] != null) out.subSport = m[6];
    } else if (global === MSG.sport) {
      if (m[0] != null && out.sport == null) out.sport = m[0];
      if (m[1] != null && out.subSport == null) out.subSport = m[1];
    } else if (global === MSG.activity && m[253] != null && m[5] != null) {
      // local_timestamp minus timestamp: the device's time zone offset, in seconds.
      const offset = m[5] - m[253];
      if (Math.abs(offset) <= 14 * 3600) out.utcOffset = offset;
    }
  }

  // bytes: Uint8Array or ArrayBuffer. Chained files (several FIT files back to back) are read in turn.
  // opts.messages: also list every data message as { global, fields: { number: value } }, raw.
  function decode(bytes, opts = {}) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!isFIT(u8)) throw new Error('Not a FIT file.');
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = { records: [], manufacturer: null, product: null, productName: '', sport: null, subSport: null, utcOffset: null };
    if (opts.messages) out.messages = [];
    let at = 0;
    while (isFIT(u8, at)) {
      const headerSize = u8[at];
      const dataSize = view.getUint32(at + 4, true);
      let end = at + headerSize + dataSize;
      if (!dataSize || end > u8.length) end = u8.length; // never finalised: read to the end
      readMessages(u8, view, at + headerSize, end, out);
      at = end + 2; // skip the file CRC
    }
    const maker = MAKERS[out.manufacturer] || '';
    const product = out.productName;
    out.creator = product && maker && !product.toLowerCase().startsWith(maker.toLowerCase()) ? maker + ' ' + product : product || maker;
    out.sportName = SPORTS[out.sport] || '';
    return out;
  }

  // ---------- encoding ----------

  // FIT CRC-16, as specified in the FIT protocol: each byte is fed in two nibbles.
  const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  function crc16(bytes, from = 0, to = bytes.length) {
    let crc = 0;
    for (let i = from; i < to; i++) {
      const b = bytes[i];
      crc = ((crc >> 4) & 0x0fff) ^ CRC_TABLE[crc & 0xf] ^ CRC_TABLE[b & 0xf];
      crc = ((crc >> 4) & 0x0fff) ^ CRC_TABLE[crc & 0xf] ^ CRC_TABLE[b >> 4];
    }
    return crc;
  }

  // Base types by name: [base type byte, size, invalid value, lowest and highest valid value].
  const TYPES = {
    enum: [0x00, 1, 0xff, 0, 0xfe], sint8: [0x01, 1, 0x7f, -0x80, 0x7e], uint8: [0x02, 1, 0xff, 0, 0xfe],
    sint16: [0x83, 2, 0x7fff, -0x8000, 0x7ffe], uint16: [0x84, 2, 0xffff, 0, 0xfffe],
    sint32: [0x85, 4, 0x7fffffff, -0x80000000, 0x7ffffffe], uint32: [0x86, 4, 0xffffffff, 0, 0xfffffffe],
    string: [0x07, 0, 0], float32: [0x88, 4, NaN],
    uint8z: [0x0a, 1, 0, 1, 0xff], uint16z: [0x8b, 2, 0, 1, 0xffff], uint32z: [0x8c, 4, 0, 1, 0xffffffff],
  };
  const PROFILE_VERSION = 2132;
  const utf8Out = new TextEncoder();

  // messages: [{ global, local = 0, fields: [[num, type, value, size?]] }], written in order.
  // A definition is written whenever a local type's layout changes. Numbers are rounded, and
  // one that is missing or out of range for its type is written as FIT's "invalid" value.
  // Strings are cut to `size` bytes (default: their length), always null-terminated.
  // To produce the variants the decoder has to handle, a message can also set bigEndian,
  // dev: [[num, size, index]] (developer fields, written as zeros) and timeOffset (0-31, for
  // a compressed-timestamp header), and opts can set headerSize (12 or 14) and dataSize
  // (written into the header in place of the real size, to mimic an unfinished file).
  function encode(messages, opts = {}) {
    const headerSize = opts.headerSize || 14;
    const body = [];
    const layouts = [];
    const scratch = new DataView(new ArrayBuffer(8));
    const push16 = (v, le) => (le ? body.push(v & 0xff, v >> 8 & 0xff) : body.push(v >> 8 & 0xff, v & 0xff));
    for (const m of messages) {
      const local = m.local || 0, le = !m.bigEndian, dev = m.dev || [];
      const fields = m.fields.map(([num, type, value, size]) => {
        const t = TYPES[type];
        if (!t) throw new Error('Unknown FIT base type: ' + type);
        if (type !== 'string') return { num, type, t, value, size: t[1] };
        let bytes = utf8Out.encode(value == null ? '' : String(value));
        size = size || bytes.length + 1;
        if (bytes.length >= size) {
          let n = size - 1;
          while (n > 0 && (bytes[n] & 0xc0) === 0x80) n--; // don't cut a character in half
          bytes = bytes.subarray(0, n);
        }
        return { num, type, t, bytes, size };
      });
      const layout = m.global + (le ? 'L' : 'B') + fields.map(f => f.num + ':' + f.size + ':' + f.t[0]).join() + '/' + dev.join(';');
      if (layouts[local] !== layout) {
        layouts[local] = layout;
        body.push(0x40 | (dev.length ? 0x20 : 0) | local, 0, le ? 0 : 1);
        push16(m.global, le);
        body.push(fields.length);
        for (const f of fields) body.push(f.num, f.size, f.t[0]);
        if (dev.length) { body.push(dev.length); for (const d of dev) body.push(d[0], d[1], d[2]); }
      }
      body.push(m.timeOffset != null ? 0x80 | (local << 5) | (m.timeOffset & 0x1f) : local);
      for (const f of fields) {
        if (f.bytes) {
          for (let k = 0; k < f.size; k++) body.push(k < f.bytes.length ? f.bytes[k] : 0);
          continue;
        }
        const [, width, invalid, lo, hi] = f.t;
        if (f.type === 'float32') {
          if (Number.isFinite(f.value)) scratch.setFloat32(0, f.value, le);
          else scratch.setUint32(0, 0xffffffff);
        } else {
          let v = f.value == null ? NaN : Math.round(f.value);
          if (!(v >= lo && v <= hi)) v = invalid;
          if (width === 1) scratch.setUint8(0, v & 0xff);
          else if (width === 2) scratch.setUint16(0, v & 0xffff, le);
          else scratch.setUint32(0, v >>> 0, le);
        }
        for (let k = 0; k < width; k++) body.push(scratch.getUint8(k));
      }
      for (const d of dev) for (let k = 0; k < d[1]; k++) body.push(0);
    }
    const out = new Uint8Array(headerSize + body.length + 2);
    const view = new DataView(out.buffer);
    out[0] = headerSize;
    out[1] = 0x20; // protocol 2.0
    view.setUint16(2, PROFILE_VERSION, true);
    view.setUint32(4, opts.dataSize != null ? opts.dataSize : body.length, true);
    out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    if (headerSize === 14) view.setUint16(12, crc16(out, 0, 12), true);
    out.set(body, headerSize);
    view.setUint16(out.length - 2, crc16(out, 0, out.length - 2), true);
    return out;
  }

  // Degrees to FIT's position unit.
  const semicircles = deg => Math.round(deg * 2 ** 31 / 180);

  const API = { decode, encode, isFIT, crc16, semicircles, FIT_EPOCH };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.FIT = API;
})(typeof window !== 'undefined' ? window : globalThis);
