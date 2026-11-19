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

// ---------- writeFIT ----------

const G = require('../js/gpx.js');
const S = require('../js/sample.js');

function line(n, start = T0, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({ t: start + i, lat: 39.6 + i * 6e-5, lon: 2.9, ele: 100 + i * 0.1, ...extra(i) }));
}

function mergeOf(files, changes = {}) {
  return G.merge(files, Object.assign(G.autoPlan(files), changes));
}

function messages(bytes, global) {
  return FIT.decode(bytes, { messages: true }).messages.filter(m => global == null || m.global === global).map(m => m.fields);
}

function outdoorPair() {
  const truth = S.ride();
  return [G.parseFile(S.toFIT(S.bikeComputer(truth)), 'computer.fit'), G.parseFile(S.toGPX(S.watch(truth)), 'watch.gpx')];
}

test('writeFIT: the merged FIT reads back with the same records', () => {
  const r = mergeOf(outdoorPair());
  const back = FIT.decode(G.writeFIT(r, { utcOffset: 0 })).records;
  assert.equal(back.length, r.points.length);
  back.forEach((b, i) => {
    const p = r.points[i];
    assert.equal(b.t, p.t);
    assert.ok(Math.abs(b.lat - p.lat) < 1e-7 && Math.abs(b.lon - p.lon) < 1e-7, 'position at ' + i);
    assert.ok(Math.abs(b.ele - p.ele) <= 0.1 + 1e-9, 'elevation at ' + i + ' (FIT stores it to 0.2 m)');
    for (const c of ['power', 'hr', 'cad', 'atemp']) assert.equal(b[c], p[c], c + ' at ' + i);
  });
});

test('writeFIT: file id, timer events, one lap, one session and the activity, with the totals', () => {
  const r = mergeOf(outdoorPair());
  const bytes = G.writeFIT(r, { utcOffset: 3600 });
  assert.equal(messages(bytes).length, r.points.length + 6);
  const order = FIT.decode(bytes, { messages: true }).messages.map(m => m.global).filter(g => g !== 20);
  assert.deepEqual(order, [0, 21, 21, 19, 18, 34], 'file id, timer start, (records), timer stop, lap, session, activity');

  const [fileId] = messages(bytes, 0);
  assert.equal(fileId[0], 4, 'an activity file');
  const [start, stop] = messages(bytes, 21);
  assert.deepEqual([start[0], start[1], stop[0], stop[1]], [0, 0, 0, 4], 'timer start, timer stop all');

  const s = r.stats, end = fitTime(s.end);
  const [lap] = messages(bytes, 19), [session] = messages(bytes, 18), [activity] = messages(bytes, 34);
  for (const [m, f] of [[lap, { sport: 25, elapsed: 7, timer: 8, distance: 9, avgPower: 19, np: 33, avgHr: 15, ascent: 21 }],
    [session, { sport: 5, elapsed: 7, timer: 8, distance: 9, avgPower: 20, np: 34, avgHr: 16, ascent: 22 }]]) {
    assert.equal(m[253], end);
    assert.equal(m[2], fitTime(s.start));
    assert.equal(m[f.sport], 2, 'cycling');
    assert.equal(m[f.elapsed], s.elapsed * 1000);
    assert.equal(m[f.timer], s.elapsed * 1000, 'no pauses');
    assert.equal(m[f.distance], Math.round(s.distance * 100));
    assert.equal(m[f.avgPower], Math.round(s.avgPower));
    assert.equal(m[f.np], Math.round(s.np));
    assert.equal(m[f.avgHr], Math.round(s.avgHr));
    assert.equal(m[f.ascent], Math.round(s.gain));
  }
  assert.deepEqual([session[25], session[26]], [0, 1], 'first lap index, number of laps');
  assert.deepEqual([activity[253], activity[1], activity[5]], [end, 1, end + 3600], 'one session, local time an hour ahead');
});

test('writeFIT: names the device, sport and time zone of the recording it is given', () => {
  const [computer, watch] = outdoorPair();
  const r = mergeOf([computer, watch]);
  computer.device = { manufacturer: 289, product: 7, name: 'Karoo' };
  computer.utcOffset = -6 * 3600;
  let bytes = G.writeFIT(r, computer);
  assert.equal(FIT.decode(bytes).creator, 'Hammerhead Karoo');
  assert.equal(messages(bytes, 0)[0][2], 7, 'product id');
  assert.equal(messages(bytes, 34)[0][5], fitTime(r.stats.end) - 6 * 3600);

  bytes = G.writeFIT(r, { creator: 'StravaGPX', type: 'running' });
  assert.equal(FIT.decode(bytes).creator, 'StravaGPX');
  assert.equal(FIT.decode(bytes).manufacturer, 255, 'a development file when the device is unknown');
  assert.equal(FIT.decode(bytes).sport, 1, 'running');
});

test('writeFIT: more than a minute with no readings stops and restarts the timer', () => {
  const pts = line(300, T0, () => ({ power: 200 })).filter((_, i) => i < 100 || i >= 190); // 90 s gap
  const r = mergeOf([G.parseFile(S.toGPX(pts), 'a.gpx')], { maxFill: 0 });
  const bytes = G.writeFIT(r, {});
  const events = messages(bytes, 21).map(e => [e[253] - fitTime(T0), e[1]]);
  assert.deepEqual(events, [[0, 0], [99, 4], [190, 0], [299, 4]]);
  const [session] = messages(bytes, 18);
  assert.equal(session[7], 299 * 1000, 'elapsed');
  assert.equal(session[8], (99 + 109) * 1000, 'timer time leaves out the gap');
  // A gap of a minute or less is not a pause.
  const short = mergeOf([G.parseFile(S.toGPX(line(300).filter((_, i) => i < 100 || i >= 159)), 'b.gpx')]);
  assert.equal(messages(G.writeFIT(short, {}), 21).length, 2);
});
