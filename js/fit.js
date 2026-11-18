// A small FIT decoder: reads the messages GPX Merge needs (file id, sport and
// the per-second records) and skips everything else. Unfinished files from a
// device that died mid-ride are read up to where they stop.
// No dependencies, so it runs in the browser (window.FITReader) and in Node (require).
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

  const MSG = { fileId: 0, sport: 12, session: 18, record: 20 };
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
        out.productName = typeof m[8] === 'string' ? m[8].trim() : '';
      }
    } else if (global === MSG.session && m[5] != null) {
      out.sport = m[5];
    } else if (global === MSG.sport && m[0] != null && out.sport == null) {
      out.sport = m[0];
    }
  }

  // bytes: Uint8Array or ArrayBuffer. Chained files (several FIT files back to back) are read in turn.
  function decode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!isFIT(u8)) throw new Error('Not a FIT file.');
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = { records: [], manufacturer: null, productName: '', sport: null };
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

  const API = { decode, isFIT, FIT_EPOCH };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.FITReader = API;
})(typeof window !== 'undefined' ? window : globalThis);
