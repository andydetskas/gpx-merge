// Run with `node --test` (Node 18 or later). Every ride here is synthetic, made by js/sample.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/gpx.js');
const FIT = require('../js/fit.js');
const S = require('../js/sample.js');

const T0 = 1781422200; // a Unix time; 2026-06-14T07:30:00Z
const fitTime = t => t - FIT.FIT_EPOCH;

// A short straight ride heading north, one point per second.
function line(n, start = T0, extra = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({ t: start + i, lat: 39.6 + i * 6e-5, lon: 2.9, ele: 100 + i * 0.1, ...extra(i) }));
}

function record(t, fields, opts = {}) {
  return { global: 20, local: opts.local || 0, bigEndian: opts.bigEndian, dev: opts.dev, timeOffset: opts.timeOffset,
    fields: (t == null ? [] : [[253, 'uint32', fitTime(t)]]).concat(fields) };
}

// ---------- FIT decoding ----------

test('FIT: decodes the sample bike computer file', () => {
  const pts = S.bikeComputer(S.ride());
  const fit = FIT.decode(S.toFIT(pts));
  assert.equal(fit.records.length, pts.length);
  assert.equal(fit.creator, 'Sample bike computer');
  assert.equal(fit.sportName, 'cycling');
  pts.forEach((p, i) => {
    const r = fit.records[i];
    assert.equal(r.t, p.t);
    if (p.lat == null) assert.equal(r.lat, undefined);
    else {
      assert.ok(Math.abs(r.lat - p.lat) < 1e-6 && Math.abs(r.lon - p.lon) < 1e-6, 'position at ' + i);
    }
    assert.equal(r.ele, p.ele);
    for (const c of ['power', 'hr', 'cad', 'atemp']) assert.equal(r[c], p[c], c + ' at ' + i);
  });
});

test('FIT: names the device from the manufacturer and product name', () => {
  const file = (manufacturer, name) => FIT.decode(FIT.encode([
    { global: 0, fields: [[1, 'uint16', manufacturer], [8, 'string', name]] },
  ])).creator;
  assert.equal(file(289, 'Karoo'), 'Hammerhead Karoo');
  assert.equal(file(1, 'Garmin Edge'), 'Garmin Edge');
  assert.equal(file(1, ''), 'Garmin');
  assert.equal(file(9999, ''), '');
});

test('FIT: compressed timestamps, including the 32-second rollover', () => {
  const start = T0 + (30 - (fitTime(T0) % 32)); // FIT time ends in 30 (mod 32)
  assert.equal(fitTime(start) % 32, 30);
  const bytes = FIT.encode([
    record(start, [[7, 'uint16', 100]]),
    record(null, [[7, 'uint16', 101]], { local: 1, timeOffset: 31 }),
    record(null, [[7, 'uint16', 102]], { local: 1, timeOffset: 0 }), // rolls over: +2 s
    record(null, [[7, 'uint16', 103]], { local: 1, timeOffset: 3 }),
  ]);
  const recs = FIT.decode(bytes).records;
  assert.deepEqual(recs.map(r => r.t - start), [0, 1, 2, 5]);
  assert.deepEqual(recs.map(r => r.power), [100, 101, 102, 103]);
});

test('FIT: big-endian definitions, developer fields and a 12-byte header', () => {
  const fields = [[0, 'sint32', FIT.semicircles(39.6)], [1, 'sint32', FIT.semicircles(-2.9)], [3, 'uint8', 150], [7, 'uint16', 321], [13, 'sint8', -5], [78, 'uint32', (250 + 500) * 5]];
  const bytes = FIT.encode([
    record(T0, fields, { bigEndian: true, dev: [[0, 4, 0], [1, 2, 0]] }),
    record(T0 + 1, fields, { bigEndian: true, dev: [[0, 4, 0], [1, 2, 0]] }),
  ], { headerSize: 12 });
  const recs = FIT.decode(bytes).records;
  assert.equal(recs.length, 2);
  for (const r of recs) {
    assert.ok(Math.abs(r.lat - 39.6) < 1e-6 && Math.abs(r.lon + 2.9) < 1e-6);
    assert.deepEqual([r.hr, r.power, r.atemp, r.ele], [150, 321, -5, 250]);
  }
});

test('FIT: invalid values, no-fix positions and plain altitude', () => {
  const recs = FIT.decode(FIT.encode([
    record(T0, [[0, 'sint32', null], [1, 'sint32', null], [7, 'uint16', null], [3, 'uint8', 140]]),
    record(T0 + 1, [[0, 'sint32', 0], [1, 'sint32', 0], [2, 'uint16', (12.4 + 500) * 5]]),
  ])).records;
  assert.equal(recs[0].lat, undefined);
  assert.equal(recs[0].power, undefined);
  assert.equal(recs[0].hr, 140);
  assert.equal(recs[1].lat, undefined, '0, 0 is treated as no fix');
  assert.equal(recs[1].ele, 12.4);
});

test('FIT: an unfinished file is read up to where it stops', () => {
  const msgs = line(5).map(p => record(p.t, [[7, 'uint16', 200]]));
  const whole = FIT.encode(msgs, { dataSize: 0 });
  const cut = whole.subarray(0, whole.length - 2 - 3); // no CRC, last record half written
  assert.equal(FIT.decode(cut).records.length, 4);
});

test('FIT: chained files are read in turn', () => {
  const a = FIT.encode(line(3).map(p => record(p.t, [[7, 'uint16', 1]])));
  const b = FIT.encode(line(3, T0 + 3).map(p => record(p.t, [[7, 'uint16', 2]])));
  const both = new Uint8Array(a.length + b.length);
  both.set(a); both.set(b, a.length);
  const recs = FIT.decode(both).records;
  assert.deepEqual(recs.map(r => r.t - T0), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(recs.map(r => r.power), [1, 1, 1, 2, 2, 2]);
});

test('parseFIT: two records in the same second are combined, first value wins', () => {
  const f = G.parseFIT(FIT.encode([
    record(T0, [[0, 'sint32', FIT.semicircles(39.6)], [1, 'sint32', FIT.semicircles(2.9)], [7, 'uint16', 250]]),
    record(T0, [[3, 'uint8', 150], [7, 'uint16', 999]], { local: 1 }),
    record(T0 + 1, [[3, 'uint8', 151]], { local: 1 }),
  ]), 'x.fit');
  assert.equal(f.pts.length, 2);
  assert.deepEqual([f.pts[0].power, f.pts[0].hr, f.pts[0].latS], [250, 150, '39.6000000']);
  assert.equal(f.located, 1, 'the second point has no position');
  assert.equal(f.coverage.hr, 2);
  assert.equal(f.format, 'fit');
});

// ---------- GPX parsing ----------

test('GPX: reads the common extension layouts and skips untimed points', () => {
  const gpx = `<?xml version="1.0"?>
<gpx creator="Strava &amp; Co" xmlns:ns3="x"><trk><name>Lunch &lt;Ride&gt;</name><type>cycling</type><trkseg>
<trkpt lat="39.6" lon="2.9"><ele>101.5</ele><time>2026-06-14T07:30:00Z</time><extensions><power>250</power><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr><gpxtpx:cad>90</gpxtpx:cad><gpxtpx:atemp>18</gpxtpx:atemp></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="39.6001" lon="2.9"><time>2026-06-14T07:30:01Z</time><extensions><ns3:TrackPointExtension><ns3:hr>141</ns3:hr></ns3:TrackPointExtension><pwr:PowerInWatts>260</pwr:PowerInWatts></extensions></trkpt>
<trkpt lat="39.6002" lon="2.9"><time>2026-06-14T07:30:01.400Z</time></trkpt>
<trkpt lat="39.6003" lon="2.9"><ele>5</ele></trkpt>
<trkpt lat="39.6004" lon="2.9"/>
</trkseg></trk></gpx>`;
  const f = G.parseFile(gpx, 'a.gpx');
  assert.equal(f.creator, 'Strava & Co');
  assert.equal(f.name, 'Lunch <Ride>');
  assert.equal(f.pts.length, 2, 'one point per second, untimed points dropped');
  assert.deepEqual([f.pts[0].power, f.pts[0].hr, f.pts[0].cad, f.pts[0].atemp, f.pts[0].eleS], [250, 140, 90, 18, '101.5']);
  assert.deepEqual([f.pts[1].power, f.pts[1].hr], [260, 141]);
  assert.equal(f.format, 'gpx');
});

test('parseFile: tells files apart by content and explains the ones it cannot read', () => {
  const gpx = S.toGPX(line(3));
  assert.equal(G.parseFile(new TextEncoder().encode(gpx), 'a.txt').format, 'gpx');
  assert.equal(G.parseFile(S.toFIT(line(3)).buffer, 'a.gpx').format, 'fit');
  assert.throws(() => G.parseFile(new Uint8Array([0x50, 0x4b, 3, 4]), 'a.zip'), /zip/);
  assert.throws(() => G.parseFile('<TrainingCenterDatabase>', 'a.tcx'), /TCX/);
  assert.throws(() => G.parseFile('hello', 'a.txt'), /Not a GPX or FIT file/);
  assert.throws(() => G.parseFile('<gpx></gpx>', 'empty.gpx'), /No timestamped track points/);
});

// ---------- clock alignment ----------

test('alignment: finds a clock error from cadence', () => {
  const truth = S.ride();
  const base = G.parseFile(S.toFIT(S.bikeComputer(truth)), 'a.fit');
  // Same ride, cadence only, on a clock 5 s slow.
  const other = G.parseFile(S.toGPX(truth.map(s => ({ t: s.t - 5, lat: s.lat, lon: s.lon, cad: s.cad }))), 'b.gpx');
  const d = G.detectOffset(base, other);
  assert.deepEqual([d.offset, d.method], [5, 'cad']);
});

test('alignment: finds a clock error from GPS speed', () => {
  const truth = S.ride();
  const base = G.parseFile(S.toFIT(S.bikeComputer(truth)), 'a.fit');
  const watch = G.parseFile(S.toGPX(S.watch(truth)), 'b.gpx'); // runs 3 s fast, no cadence
  const d = G.detectOffset(base, watch);
  assert.deepEqual([d.offset, d.method], [-3, 'speed']);
});

test('alignment: reports no match when the recordings do not overlap', () => {
  const a = G.parseFile(S.toGPX(line(120, T0, i => ({ cad: i % 7 ? 90 : 0 }))), 'a.gpx');
  const b = G.parseFile(S.toGPX(line(120, T0 + 3600, i => ({ cad: i % 7 ? 90 : 0 }))), 'b.gpx');
  assert.equal(G.detectOffset(a, b).method, 'none');
});

// ---------- merging ----------

function mergeOf(files, changes = {}) {
  const plan = Object.assign(G.autoPlan(files), changes);
  return G.merge(files, plan);
}

test('gaps: short gaps are interpolated, coasts are filled with 0, long gaps are left', () => {
  const power = [200, null, null, 230, 100, null, null, 0, 0, 150, null, null, null, null, null, null, null, 300];
  const f = G.parseFile(S.toGPX(line(power.length, T0, i => (power[i] == null ? {} : { power: power[i] }))), 'a.gpx');
  const r = mergeOf([f]);
  const out = r.points.map(p => p.power);
  assert.deepEqual(out.slice(0, 4), [200, 210, 220, 230], 'linear fill');
  assert.deepEqual(out.slice(4, 9), [100, 0, 0, 0, 0], 'a gap ending in 0 is a coast');
  assert.deepEqual(out.slice(10, 17), Array(7).fill(undefined), '7 s is longer than the 5 s limit');
  assert.deepEqual(r.fills.map(x => x.how), ['interpolated', 'interpolated', 'coast', 'coast']);
  // A higher limit fills the long gap too.
  assert.equal(mergeOf([f], { maxFill: 10 }).points[13].power, 150 + (300 - 150) * 4 / 8);
});

test('gaps: heart rate is not coast-aware; a gap ending in 0 is interpolated', () => {
  const hr = [120, null, 0];
  const f = G.parseFile(S.toGPX(line(3, T0, i => (hr[i] == null ? {} : { hr: hr[i] }))), 'a.gpx');
  assert.equal(mergeOf([f]).points[1].hr, 60);
});

test('merge: borrows a channel from another file when the chosen source has nothing', () => {
  const a = G.parseFile(S.toGPX(line(60, T0, i => ({ power: 200, hr: i >= 20 && i < 40 ? undefined : 130 }))), 'a.gpx');
  const b = G.parseFile(S.toGPX(line(60, T0, () => ({ hr: 150 }))), 'b.gpx');
  const plan = G.autoPlan([a, b]);
  plan.sources.hr = 0; // keep a's heart rate, with its 20 s hole
  const r = G.merge([a, b], plan);
  assert.equal(r.borrowed.hr, 20);
  assert.ok(r.points.slice(20, 40).every(p => p.hr === 150));
  const off = G.merge([a, b], Object.assign({}, plan, { fillTimeline: false }));
  assert.equal(off.points[30].hr, undefined);
});

test('merge: a GPS dropout in a FIT base is filled with the other track, keeping its own power', () => {
  const truth = S.ride();
  const fit = G.parseFile(S.toFIT(S.bikeComputer(truth)), 'computer.fit');
  const watch = G.parseFile(S.toGPX(S.watch(truth)), 'watch.gpx');
  const files = [watch, fit];
  const plan = G.autoPlan(files);
  assert.equal(plan.base, 1, 'the file with power and GPS is the base');
  assert.equal(plan.name, 'Sample loop', 'name comes from the GPX when the FIT has none');
  const r = G.merge(files, plan);

  // The tunnel is samples 2620-2659. The base has no fix there; within 3 s of its
  // last and next fix nothing is added, the 34 seconds between come from the watch.
  const tunnel = r.points.filter(p => p.t >= truth[2620].t && p.t < truth[2660].t);
  assert.equal(r.inserted, 34);
  assert.equal(tunnel.length, 34);
  assert.ok(tunnel.every(p => p.src === 0));
  tunnel.forEach(p => assert.equal(p.power, truth[p.t - truth[0].t].power, 'power from the FIT, not the watch'));

  const strap = r.points.filter(p => p.t >= truth[1500].t && p.t < truth[1545].t);
  assert.equal(r.borrowed.hr, 45, 'heart rate borrowed while the chest strap slipped');
  assert.ok(strap.every(p => p.hr != null));
  assert.equal(r.stats.coverage.power, r.stats.points, 'no blank power');
  assert.equal(r.stats.points, r.points.length);
  assert.equal(r.points[0].src, 1);
});

test('merge: points without a fix in another file never become track points', () => {
  // Base GPX stops for 40 s; the other file is a FIT with no position for half of that time.
  const base = G.parseFile(S.toGPX(line(100, T0, () => ({ power: 200 })).filter((_, i) => i < 30 || i >= 70)), 'a.gpx');
  const other = G.parseFIT(FIT.encode(line(100).map((p, i) => record(p.t, [
    [0, 'sint32', i < 50 ? FIT.semicircles(p.lat) : null], [1, 'sint32', i < 50 ? FIT.semicircles(p.lon) : null], [3, 'uint8', 140],
  ]))), 'b.fit');
  const r = G.merge([base, other], G.autoPlan([base, other]));
  const added = r.points.filter(p => p.src === 1);
  assert.deepEqual(added.map(p => p.t - T0), Array.from({ length: 50 - 33 }, (_, k) => 33 + k));
  assert.ok(r.points.every(p => p.latS && p.lonS));
  assert.ok(!G.writeGPX(r, {}).includes('undefined'));
});

test('merge: elevation borrowed from another file is corrected for its bias', () => {
  const a = G.parseFile(S.toGPX(line(80, T0, i => ({ ele: i >= 30 && i < 50 ? undefined : 100 }))), 'a.gpx');
  const b = G.parseFile(S.toGPX(line(80, T0, () => ({ ele: 107 }))), 'b.gpx');
  const plan = G.autoPlan([a, b]);
  plan.base = 0; plan.sources.ele = 0;
  const r = G.merge([a, b], plan);
  assert.ok(r.points.slice(30, 50).every(p => p.ele === 100), 'shifted by the median 7 m difference');
});

test('autoPlan: a file without GPS is never the base', () => {
  const noGps = G.parseFIT(FIT.encode(line(120).map(p => record(p.t, [[7, 'uint16', 250]]))), 'trainer.fit');
  const gps = G.parseFile(S.toGPX(line(120)), 'phone.gpx');
  assert.equal(noGps.located, 0);
  const plan = G.autoPlan([noGps, gps]);
  assert.equal(plan.base, 1);
  assert.equal(plan.sources.power, 0);
  const r = G.merge([noGps, gps], plan);
  assert.equal(r.points.length, 120);
  assert.ok(r.points.every(p => p.power === 250));
});

// ---------- GPX output ----------

test('writeGPX: output reads back with the same points and values', () => {
  const truth = S.ride();
  const files = [G.parseFile(S.toFIT(S.bikeComputer(truth)), 'a.fit'), G.parseFile(S.toGPX(S.watch(truth)), 'b.gpx')];
  const r = mergeOf(files);
  const xml = G.writeGPX(r, { name: 'Loop & <back>', creator: 'Sample "computer"' });
  assert.match(xml, /<name>Loop &amp; &lt;back&gt;<\/name>/);
  assert.match(xml, /creator="Sample &quot;computer&quot;"/);
  assert.match(xml, /<power>\d+<\/power>/);
  assert.match(xml, /<gpxtpx:hr>\d+<\/gpxtpx:hr>/);
  const back = G.parseFile(xml, 'out.gpx');
  assert.equal(back.name, 'Loop & <back>');
  assert.equal(back.pts.length, r.points.length);
  back.pts.forEach((p, i) => {
    const q = r.points[i];
    assert.equal(p.t, q.t);
    assert.equal(p.latS, q.latS);
    for (const c of G.CHANNELS) assert.equal(p[c], q[c], c + ' at ' + i);
  });
});

test('writeGPX: a GPX base keeps its coordinates, elevation and times exactly as written', () => {
  const gpx = S.toGPX(line(5)).replace(/<time>([^<]+)Z<\/time>/g, '<time>$1.000Z</time>');
  const f = G.parseFile(gpx, 'a.gpx');
  const xml = G.writeGPX(mergeOf([f]), {});
  for (const p of f.pts) {
    assert.ok(xml.includes('<trkpt lat="' + p.latS + '" lon="' + p.lonS + '">'));
    assert.ok(xml.includes('<ele>' + p.eleS + '</ele>'));
    assert.ok(xml.includes('<time>' + p.timeS + '</time>'));
  }
  assert.match(xml, /\.000Z<\/time>/);
});
