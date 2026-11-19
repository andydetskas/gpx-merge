// Run with `node --test` (Node 18 or later). Every ride here is synthetic, made by js/sample.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FIT = require('../js/fit.js');

const T0 = 1781422200; // a Unix time; 2026-06-14T07:30:00Z
const fitTime = t => t - FIT.FIT_EPOCH;

// ---------- encoder ----------

test('FIT encode: header, data size and both CRCs', () => {
  const bytes = FIT.encode([{ global: 20, fields: [[253, 'uint32', fitTime(T0)], [7, 'uint16', 250]] }]);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes[0], 14);
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), '.FIT');
  assert.equal(view.getUint32(4, true), bytes.length - 14 - 2);
  assert.equal(view.getUint16(12, true), FIT.crc16(bytes, 0, 12));
  assert.equal(FIT.crc16(bytes), 0, 'a CRC over the data and its own CRC comes to 0');
});

test('FIT encode: rounds numbers, writes out-of-range values as invalid, cuts long strings', () => {
  const fit = FIT.decode(FIT.encode([
    { global: 0, fields: [[1, 'uint16', 1], [8, 'string', 'Ünïcode bike computer', 5]] },
    { global: 20, local: 1, fields: [[253, 'uint32', fitTime(T0)], [7, 'uint16', 249.6], [3, 'uint8', 300], [4, 'uint8', -1], [13, 'sint8', -12.4]] },
  ]));
  assert.equal(fit.productName, 'Ün', '4 bytes and a terminator fit; half of the ï does not');
  assert.deepEqual(fit.records[0], { t: T0, power: 250, atemp: -12 });
});
