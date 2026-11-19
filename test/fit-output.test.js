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

// ---------- rides with no GPS ----------

test('merge (FIT): an indoor ride with no GPS is merged from its timestamps', () => {
  const truth = S.indoorRide();
  const files = S.indoorDemoFiles().map(f => G.parseFile(f.data, f.name));
  const plan = G.autoPlan(files);
  assert.equal(G.merge(files, plan).points.length, 0, 'a GPX merge has nothing to write');

  const r = G.merge(files, plan, { format: 'fit' });
  assert.equal(r.format, 'fit');
  // Every second of the trainer app, then the watch's last 12 s: it stopped 15 s later, and
  // seconds within 3 s of the trainer app's last one are left to it.
  assert.equal(r.inserted, 12);
  assert.deepEqual(r.points.map(p => p.t), Array.from({ length: truth.length + 12 }, (_, k) => truth[0].t + (k < truth.length ? k : k + 3)));
  assert.ok(r.points.every(p => p.lat == null));
  assert.deepEqual(r.fills.map(f => [f.t - truth[0].t, f.ch]), [[1500, 'power'], [1501, 'power'], [1502, 'power']]);
  r.points.slice(0, truth.length).forEach((p, k) => {
    assert.equal(p.cad, truth[k].cad);
    if (k < 1500 || k >= 1503) assert.equal(p.power, truth[k].power);
  });
  // Heart rate from the watch, on the trainer's clock: the watch started 25 s late.
  assert.ok(r.points.slice(0, 25).every(p => p.hr == null));
  assert.ok(r.points.slice(25).every(p => p.hr != null));
  assert.equal(r.stats.distance, 0);

  const bytes = G.writeFIT(r, files[plan.base]);
  const back = FIT.decode(bytes);
  assert.equal(back.records.length, r.points.length);
  back.records.forEach((b, i) => {
    const p = r.points[i];
    assert.deepEqual(b, Object.fromEntries(Object.entries({ t: p.t, power: p.power, hr: p.hr, cad: p.cad }).filter(([, v]) => v != null)));
  });
  const recordDef = FIT.decode(bytes, { messages: true }).messages.find(m => m.global === 20);
  assert.ok(!(0 in recordDef.fields) && !(78 in recordDef.fields), 'no position or elevation fields at all');
  const [session] = messages(bytes, 18);
  assert.deepEqual([session[5], session[6]], [2, 6], 'cycling, indoor cycling (from the trainer app)');
  assert.ok(!(9 in session) && !(3 in session), 'no distance or start position');
  assert.equal(G.writeFIT(r, {}).length, bytes.length);
  assert.equal(messages(G.writeFIT(r, {}), 18)[0][6], 6, 'indoor cycling when nothing says otherwise');
});

test('merge (FIT): keeps seconds without GPS, borrowing a position only away from the base fixes', () => {
  const truth = S.ride();
  const [computer, watch] = outdoorPair(); // the computer loses GPS in a tunnel, samples 2620-2659
  const plan = G.autoPlan([computer, watch]);
  const gpx = G.merge([computer, watch], plan);
  const r = G.merge([computer, watch], plan, { format: 'fit' });

  const tunnel = r.points.filter(p => p.t >= truth[2620].t && p.t < truth[2660].t);
  assert.equal(tunnel.length, 40, 'every second of the tunnel is kept');
  assert.ok(tunnel.every(p => p.src === 0 && p.power === truth[p.t - truth[0].t].power), 'with the computer\'s own power');
  // Within 3 s of the computer's last and next fix there is no position; the 34 s between come from the watch.
  assert.deepEqual(tunnel.map(p => p.lat != null), Array.from({ length: 40 }, (_, k) => k >= 3 && k < 37));
  assert.equal(r.borrowed.gps, 34);
  const fromWatch = new Map(watch.pts.map(p => [p.t + plan.offsets[1], p]));
  tunnel.filter(p => p.lat != null).forEach(p => assert.equal(p.latS, fromWatch.get(p.t).latS));

  // The GPX made from this merge is the same as the GPX merge, for this pair.
  assert.equal(r.points.length, gpx.points.length + 6);
  assert.equal(G.writeGPX(r, { name: 'x' }), G.writeGPX(gpx, { name: 'x' }));
  assert.equal(r.stats.distance, gpx.stats.distance);

  const back = FIT.decode(G.writeFIT(r, computer)).records;
  assert.equal(back.filter(b => b.lat == null).length, 6);
});
