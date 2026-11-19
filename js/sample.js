// Synthetic rides for the demo button and the tests: one made-up loop, "recorded"
// by two devices that disagree the way real ones do. No real GPS track is involved.
// Runs in the browser (window.GPXSample, after js/fit.js) and in Node.
(function (root) {
  'use strict';

  const FIT = typeof module !== 'undefined' && module.exports ? require('./fit.js') : root.FIT;
  const { FIT_EPOCH, semicircles } = FIT;

  // ---------- deterministic randomness ----------

  function rng(seed) {
    let s = seed >>> 0;
    const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    next.gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next());
    return next;
  }

  // Smooth, mean-reverting noise, like GPS drift (white noise would make GPS speed useless).
  function drift(rand, sigma, keep = 0.97) {
    let v = 0;
    const k = sigma * Math.sqrt(1 - keep * keep);
    return () => (v = v * keep + rand.gauss() * k);
  }

  // ---------- the ride itself ----------

  // [kind, seconds, watts, grade]
  const PLAN = [
    ['stop', 15], ['ride', 600, 180, 0.005], ['stop', 35], ['ride', 420, 210, 0.01],
    ['ride', 720, 265, 0.055], ['descend', 420, 0, -0.045], ['ride', 300, 200, 0],
    ['ride', 180, 340, 0.01], ['ride', 180, 150, 0], ['ride', 180, 340, 0.01],
    ['ride', 480, 190, -0.005], ['stop', 25], ['ride', 480, 170, -0.01], ['stop', 20],
  ];

  // Steady speed (m/s) for a power and grade: 82 kg rider and bike, hoods position.
  function steadySpeed(watts, grade) {
    let lo = 0, hi = 18;
    for (let i = 0; i < 40; i++) {
      const v = (lo + hi) / 2;
      const need = v * (82 * 9.81 * (0.004 + grade) + 0.5 * 1.1 * 0.32 * v * v);
      if (need > watts) hi = v; else lo = v;
    }
    return lo;
  }

  // One sample per second of what "really" happened. start: Unix seconds.
  function ride({ start = 1781422200, seed = 7, lat = 39.64, lon = 2.98 } = {}) {
    const rand = rng(seed);
    const out = [];
    let t = start, v = 0, ele = 120, hr = 92, heading = 0.4, coast = 0, pedalBurst = 0;
    const total = PLAN.reduce((a, s) => a + s[1], 0);
    for (const [kind, secs, watts, grade = 0] of PLAN) {
      for (let i = 0; i < secs; i++, t++) {
        let p = 0, cad = 0;
        if (kind === 'ride') {
          if (coast > 0) coast--;
          else if (rand() < 1 / 90) coast = 3 + Math.floor(rand() * 9);
        } else if (kind === 'descend') {
          if (pedalBurst > 0) pedalBurst--;
          else if (rand() < 1 / 60) pedalBurst = 8 + Math.floor(rand() * 12);
        }
        const pedalling = (kind === 'ride' && !coast) || (kind === 'descend' && pedalBurst > 0);
        if (pedalling) {
          p = Math.max(40, Math.round((kind === 'descend' ? 150 : watts) * (1 + 0.07 * rand.gauss())));
          cad = Math.round((grade > 0.03 ? 78 : 88) + 3 * rand.gauss());
        }
        if (kind === 'stop') v = Math.max(0, v - 1.6);
        else v += (Math.min(16, steadySpeed(p, grade)) - v) / (p ? 9 : 14);
        if (v < 0.1) v = 0;
        ele += v * grade;
        hr += (95 + 0.27 * p - hr) / 22 + 0.4 * rand.gauss();
        heading += (2 * Math.PI) * (v / (total * 8.4)) + 0.002 * rand.gauss();
        lat += (v * Math.cos(heading)) / 111320;
        lon += (v * Math.sin(heading)) / (111320 * Math.cos(lat * Math.PI / 180));
        const temp = Math.round(17 + 4 * (t - start) / total);
        out.push({ t, lat, lon, ele, speed: v, power: p, cad, hr: Math.round(hr), atemp: temp });
      }
    }
    return out;
  }

  // ---------- two devices ----------

  // A bike computer recording FIT: power, cadence, chest-strap heart rate, barometric
  // elevation. It loses GPS for 40 s in a tunnel, drops a few power readings, and
  // loses heart rate for 45 s when the strap slips.
  function bikeComputer(truth, seed = 11) {
    const rand = rng(seed), dLat = drift(rand, 1.5), dLon = drift(rand, 1.5);
    const tunnel = [2620, 2660], strap = [1500, 1545];
    // Power dropouts: two mid-pedalling, one that runs into a coast (so it ends in 0).
    const holes = new Set();
    for (const at of [800, 1900]) for (let k = 0; k < 3; k++) holes.add(at + k);
    const coastAt = truth.findIndex((s, i) => i > 3000 && truth[i - 1].power > 0 && s.power === 0 && truth[i + 3].power === 0);
    holes.add(coastAt - 2); holes.add(coastAt - 1);
    return truth.map((s, i) => {
      const r = { t: s.t, ele: Math.round((s.ele + 0.3 * rand.gauss()) * 5) / 5, cad: s.cad, atemp: s.atemp };
      if (i < tunnel[0] || i >= tunnel[1]) { r.lat = s.lat + dLat() / 111320; r.lon = s.lon + dLon() / 85700; }
      if (!holes.has(i)) r.power = s.power;
      if (i < strap[0] || i >= strap[1]) r.hr = s.hr;
      return r;
    });
  }

  // A GPS watch recording GPX: its own GPS, GPS-derived elevation that reads 7 m high,
  // optical heart rate, no power or cadence. Its clock runs 3 s fast, it was started
  // 30 s after the bike computer and stopped 2 s after it.
  function watch(truth, seed = 23) {
    const rand = rng(seed), dLat = drift(rand, 3), dLon = drift(rand, 3), dEle = drift(rand, 2);
    const out = [];
    for (let i = 30; i < truth.length + 2; i++) {
      const s = truth[Math.min(i, truth.length - 1)];
      const moved = i < truth.length ? 0 : (i - truth.length + 1);
      out.push({
        t: truth[0].t + i + 3,
        lat: s.lat + dLat() / 111320 + moved * 1.2e-5,
        lon: s.lon + dLon() / 85700,
        ele: Math.round((s.ele + 7 + dEle()) * 10) / 10,
        hr: Math.max(60, Math.round(truth[Math.max(0, Math.min(i, truth.length - 1) - 3)].hr + 1.5 * rand.gauss())),
      });
    }
    return out;
  }

  // ---------- writers ----------

  const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

  function toGPX(points, { name = 'Sample loop', creator = 'Sample watch' } = {}) {
    const o = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx creator="' + creator + '" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
      ' <trk>', '  <name>' + name + '</name>', '  <type>cycling</type>', '  <trkseg>',
    ];
    for (const p of points) {
      o.push('   <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '">');
      if (p.ele != null) o.push('    <ele>' + p.ele.toFixed(1) + '</ele>');
      o.push('    <time>' + iso(p.t) + '</time>');
      const x = [];
      if (p.hr != null) x.push('<gpxtpx:hr>' + p.hr + '</gpxtpx:hr>');
      if (p.cad != null) x.push('<gpxtpx:cad>' + p.cad + '</gpxtpx:cad>');
      if (p.power != null) o.push('    <extensions><power>' + p.power + '</power>' + (x.length ? '<gpxtpx:TrackPointExtension>' + x.join('') + '</gpxtpx:TrackPointExtension>' : '') + '</extensions>');
      else if (x.length) o.push('    <extensions><gpxtpx:TrackPointExtension>' + x.join('') + '</gpxtpx:TrackPointExtension></extensions>');
      o.push('   </trkpt>');
    }
    o.push('  </trkseg>', ' </trk>', '</gpx>', '');
    return o.join('\n');
  }

  // An activity FIT with a file id, one record per sample and a session.
  function toFIT(points, { productName = 'Sample bike computer', manufacturer = 255, sport = 2 } = {}) {
    const fit = t => t - FIT_EPOCH;
    const msgs = [{
      global: 0, fields: [[0, 'enum', 4], [1, 'uint16', manufacturer], [2, 'uint16', 1], [4, 'uint32', fit(points[0].t)], [8, 'string', productName, 24]],
    }];
    for (const p of points) {
      msgs.push({
        global: 20, local: 1, fields: [
          [253, 'uint32', fit(p.t)],
          [0, 'sint32', p.lat != null ? semicircles(p.lat) : null],
          [1, 'sint32', p.lon != null ? semicircles(p.lon) : null],
          [78, 'uint32', p.ele != null ? Math.round((p.ele + 500) * 5) : null],
          [3, 'uint8', p.hr], [4, 'uint8', p.cad], [7, 'uint16', p.power], [13, 'sint8', p.atemp],
        ],
      });
    }
    const last = points[points.length - 1].t;
    msgs.push({ global: 18, local: 2, fields: [[253, 'uint32', fit(last)], [2, 'uint32', fit(points[0].t)], [5, 'enum', sport]] });
    return FIT.encode(msgs);
  }

  // The demo pair: a FIT file from the bike computer and a GPX file from the watch.
  // start: Unix seconds for the start of the ride.
  function demoFiles(start) {
    const truth = ride(start ? { start } : {});
    return [
      { name: 'bike-computer.fit', data: toFIT(bikeComputer(truth)) },
      { name: 'watch.gpx', data: toGPX(watch(truth)) },
    ];
  }

  const API = { rng, ride, bikeComputer, watch, toGPX, toFIT, demoFiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.GPXSample = API;
})(typeof window !== 'undefined' ? window : globalThis);
