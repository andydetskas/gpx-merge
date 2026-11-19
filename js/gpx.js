// GPX and FIT parsing, clock alignment, merging and GPX writing.
// No DOM dependencies, so it runs in the browser (window.GPXMerge) and in Node (require).
(function (root) {
  'use strict';

  const FIT = typeof module !== 'undefined' && module.exports ? require('./fit.js') : root.FIT;

  const CHANNELS = ['ele', 'power', 'hr', 'cad', 'atemp'];
  const CHANNEL_LABELS = { ele: 'Elevation', power: 'Power', hr: 'Heart rate', cad: 'Cadence', atemp: 'Temperature' };
  const CHANNEL_UNITS = { ele: 'm', power: 'W', hr: 'bpm', cad: 'rpm', atemp: '°C' };
  // A gap that ends in a zero reading is the start of a coast: fill it with 0, not a ramp.
  const COAST_AWARE = { power: true, cad: true };

  // ---------- parsing ----------

  function attr(s, name) {
    const m = s.match(new RegExp('\\b' + name + '="([^"]*)"'));
    return m ? m[1] : null;
  }

  function decodeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseGPX(text, fileName) {
    const creator = decodeXml((text.slice(0, 4000).match(/<gpx\b[^>]*?\bcreator="([^"]*)"/) || [])[1] || '');
    const trkHead = (text.match(/<trk\b[^>]*>([\s\S]*?)<trkseg/) || [])[1] || '';
    const name = decodeXml((trkHead.match(/<name>([^<]*)<\/name>/) || [])[1] || '');
    const type = (trkHead.match(/<type>([^<]*)<\/type>/) || [])[1] || '';

    const bySecond = new Map();
    const ptRe = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
    // Matches tags regardless of namespace prefix (gpxtpx:hr, ns3:hr, pwr:PowerInWatts, ...).
    const tagRe = /<(?:[\w-]+:)?(ele|time|power|PowerInWatts|hr|cad|atemp|temp)>([^<]*)</g;
    let m;
    while ((m = ptRe.exec(text))) {
      const latS = attr(m[1], 'lat'), lonS = attr(m[1], 'lon');
      const p = { latS, lonS, lat: parseFloat(latS), lon: parseFloat(lonS) };
      const body = m[2] || '';
      tagRe.lastIndex = 0;
      let t;
      while ((t = tagRe.exec(body))) {
        const k = t[1], v = t[2].trim();
        if (k === 'time') {
          p.timeS = v;
          p.t = Math.round(Date.parse(v) / 1000);
          continue;
        }
        const n = parseFloat(v);
        if (!isFinite(n)) continue;
        if (k === 'ele') { p.ele = n; p.eleS = v; }
        else p[k === 'PowerInWatts' ? 'power' : k === 'temp' ? 'atemp' : k] = n;
      }
      if (isFinite(p.t) && isFinite(p.lat) && isFinite(p.lon) && !bySecond.has(p.t)) bySecond.set(p.t, p);
    }
    return summarize({ fileName, format: 'gpx', creator, name, type }, bySecond);
  }

  // FIT records can lack a position (before the first fix, in a tunnel). They are
  // kept, so their power or heart rate can still be used, but never become track points.
  function parseFIT(bytes, fileName) {
    const fit = FIT.decode(bytes);
    const bySecond = new Map();
    for (const r of fit.records) {
      let p = bySecond.get(r.t);
      if (!p) bySecond.set(r.t, (p = { t: r.t, timeS: isoSecond(r.t) }));
      // Some devices write two records in the same second; the first value of each field wins.
      if (p.lat == null && r.lat != null) {
        p.lat = r.lat; p.lon = r.lon; p.latS = r.lat.toFixed(7); p.lonS = r.lon.toFixed(7);
      }
      if (p.ele == null && r.ele != null) { p.ele = r.ele; p.eleS = String(r.ele); }
      for (const c of ['power', 'hr', 'cad', 'atemp']) if (p[c] == null && r[c] != null) p[c] = r[c];
    }
    return summarize({ fileName, format: 'fit', creator: fit.creator, name: '', type: fit.sportName }, bySecond);
  }

  function summarize(file, bySecond) {
    const pts = [...bySecond.values()].sort((a, b) => a.t - b.t);
    if (!pts.length) throw new Error('No timestamped track points found.');
    const coverage = {};
    for (const c of CHANNELS) coverage[c] = pts.filter(p => p[c] != null).length;
    const located = pts.filter(hasFix).length;
    let gaps = 0, gapSeconds = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].t - pts[i - 1].t;
      if (d > 2) { gaps++; gapSeconds += d - 1; }
    }
    return Object.assign(file, { pts, coverage, located, gaps, gapSeconds, start: pts[0].t, end: pts[pts.length - 1].t });
  }

  // Reads a GPX or FIT file, telling them apart by content rather than by name.
  // data: Uint8Array, ArrayBuffer or (GPX only) a string.
  function parseFile(data, fileName) {
    if (typeof data !== 'string') {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (FIT.isFIT(u8)) return parseFIT(u8, fileName);
      if (u8[0] === 0x50 && u8[1] === 0x4b) throw new Error('This is a .zip archive. Unzip it and add the file inside.');
      data = new TextDecoder().decode(u8);
    }
    if (/<TrainingCenterDatabase\b/.test(data)) throw new Error('TCX files aren\'t supported yet. Export the ride as GPX or FIT.');
    if (!/<gpx\b/.test(data)) throw new Error('Not a GPX or FIT file.');
    return parseGPX(data, fileName);
  }

  // ---------- helpers ----------

  const hasFix = p => p.lat != null;

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const p1 = a.lat * rad, p2 = b.lat * rad, dp = p2 - p1, dl = (b.lon - a.lon) * rad;
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
  }

  function ensureSpeed(file) {
    if (file.hasSpeed) return;
    for (let i = 1; i < file.pts.length; i++) {
      const a = file.pts[i - 1], b = file.pts[i], dt = b.t - a.t;
      if (dt > 0 && dt <= 5 && hasFix(a) && hasFix(b)) b.speed = haversine(a, b) / dt;
    }
    file.hasSpeed = true;
  }

  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  function isoSecond(t) {
    return new Date(t * 1000).toISOString().replace('.000Z', 'Z');
  }

  function shiftedIndex(file, offset) {
    const m = new Map();
    for (const p of file.pts) m.set(p.t + offset, p);
    return m;
  }

  // ---------- clock alignment ----------

  // Finds the shift (seconds added to `other`) that best lines it up with `base`,
  // by comparing cadence when both files have it, otherwise GPS speed.
  function detectOffset(base, other, range = 30) {
    const useCad = base.coverage.cad > 60 && other.coverage.cad > 60;
    const key = useCad ? 'cad' : 'speed';
    if (!useCad) { ensureSpeed(base); ensureSpeed(other); }
    const bmap = shiftedIndex(base, 0);
    let best = null;
    for (let off = -range; off <= range; off++) {
      let sum = 0, n = 0;
      for (const p of other.pts) {
        const q = bmap.get(p.t + off);
        if (q && q[key] != null && p[key] != null) { sum += Math.abs(q[key] - p[key]); n++; }
      }
      if (n >= 60 && (!best || sum / n < best.mae)) best = { offset: off, mae: sum / n, n };
    }
    if (!best) return { offset: 0, method: 'none' };
    return { offset: best.offset, method: key, mae: best.mae, n: best.n };
  }

  // ---------- planning ----------

  function autoPlan(files) {
    // The base supplies the track, so it has to have GPS. Prefer the one with power.
    const powered = files.map((f, i) => [f.coverage.power, i]).filter(([c, i]) => c > 0 && files[i].located).sort((a, b) => b[0] - a[0]);
    const base = powered.length ? powered[0][1] : files.map((f, i) => [f.located, i]).sort((a, b) => b[0] - a[0])[0][1];
    const name = files[base].name || (files.find(f => f.name) || {}).name || 'Merged ride';
    const plan = { base, offsets: [], detected: [], sources: {}, maxFill: 5, fillTimeline: true, name };
    planOffsets(files, plan);
    for (const ch of CHANNELS) {
      let pick = null;
      files.forEach((f, i) => {
        if (!f.coverage[ch]) return;
        if (pick == null) { pick = i; return; }
        const cur = files[pick].coverage[ch], cand = f.coverage[ch];
        // Prefer the base file unless another file covers clearly more of the ride.
        if (pick === base ? cand > cur * 1.01 : (i === base ? cand >= cur * 0.99 : cand > cur)) pick = i;
      });
      plan.sources[ch] = pick;
    }
    return plan;
  }

  function planOffsets(files, plan) {
    plan.detected = files.map((f, i) => (i === plan.base ? { offset: 0, method: 'base' } : detectOffset(files[plan.base], f)));
    plan.offsets = plan.detected.map(d => d.offset);
  }

  // ---------- merging ----------

  function fillGaps(vals, timeline, maxFill, coastAware, ch, log) {
    let i = 0;
    while (i < vals.length) {
      if (vals[i] != null) { i++; continue; }
      let j = i;
      while (j < vals.length && vals[j] == null) j++;
      if (i > 0 && j < vals.length) {
        const t0 = timeline[i - 1].t, t1 = timeline[j].t;
        if (t1 - t0 - 1 <= maxFill) {
          const a = vals[i - 1], b = vals[j], coast = coastAware && b === 0;
          for (let k = i; k < j; k++) {
            const v = coast ? 0 : a + (b - a) * (timeline[k].t - t0) / (t1 - t0);
            vals[k] = ch === 'ele' ? Math.round(v * 10) / 10 : Math.round(v);
            log.push({ k, t: timeline[k].t, ch, value: vals[k], how: coast ? 'coast' : 'interpolated' });
          }
        }
      }
      i = j;
    }
  }

  function merge(files, plan) {
    const base = files[plan.base];
    const idx = files.map((f, i) => shiftedIndex(f, i === plan.base ? 0 : plan.offsets[i] || 0));

    // Timeline: every base point with a GPS fix, plus points from other files wherever
    // the base has no fix within 3 s (a dropout, or a late start / early stop).
    const timeline = base.pts.filter(hasFix).map(p => ({ t: p.t, src: plan.base, p }));
    let inserted = 0;
    if (plan.fillTimeline && files.length > 1) {
      const baseTimes = timeline.map(e => e.t);
      const taken = new Set(baseTimes);
      const nearestDist = t => {
        let lo = 0, hi = baseTimes.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (baseTimes[mid] < t) lo = mid + 1; else hi = mid; }
        let d = Math.abs(baseTimes[lo] - t);
        if (lo > 0) d = Math.min(d, Math.abs(baseTimes[lo - 1] - t));
        return d;
      };
      files.forEach((f, i) => {
        if (i === plan.base) return;
        for (const [t, p] of idx[i]) {
          if (!hasFix(p) || taken.has(t) || nearestDist(t) <= 3) continue;
          timeline.push({ t, src: i, p });
          taken.add(t);
          inserted++;
        }
      });
      timeline.sort((a, b) => a.t - b.t);
    }

    // Elevation bias between files, so donor points don't step up or down.
    const eleSrc = plan.sources.ele;
    const eleBias = files.map((f, i) => {
      if (eleSrc == null || i === eleSrc) return 0;
      const d = [];
      for (const [t, p] of idx[i]) { const q = idx[eleSrc].get(t); if (q && q.ele != null && p.ele != null) d.push(q.ele - p.ele); }
      return median(d);
    });

    const series = {};
    const eleText = [];
    for (const ch of CHANNELS) {
      const s = plan.sources[ch];
      series[ch] = timeline.map((e, k) => {
        if (s == null) return null;
        const q = idx[s].get(e.t);
        if (q && q[ch] != null) { if (ch === 'ele') eleText[k] = q.eleS; return q[ch]; }
        return null;
      });
    }

    // Short gaps in the chosen source are filled from its own neighbours first;
    // anything still blank is borrowed from another file that recorded it.
    const fills = [], borrowed = {};
    for (const ch of CHANNELS) {
      const s = plan.sources[ch];
      if (s == null) continue;
      fillGaps(series[ch], timeline, plan.maxFill, !!COAST_AWARE[ch], ch, fills);
      if (!plan.fillTimeline) continue;
      const donors = files.map((_, i) => i).filter(i => i !== s && files[i].coverage[ch]);
      series[ch].forEach((v, k) => {
        if (v != null) return;
        for (const i of donors) {
          const q = idx[i].get(timeline[k].t);
          if (!q || q[ch] == null) continue;
          series[ch][k] = ch === 'ele' ? Math.round((q.ele + eleBias[i]) * 10) / 10 : q[ch];
          borrowed[ch] = (borrowed[ch] || 0) + 1;
          break;
        }
      });
    }

    const points = timeline.map((e, k) => {
      const out = {
        t: e.t, src: e.src, lat: e.p.lat, lon: e.p.lon, latS: e.p.latS, lonS: e.p.lonS,
        timeS: e.src === plan.base && e.p.timeS ? e.p.timeS : isoSecond(e.t),
      };
      for (const ch of CHANNELS) if (series[ch][k] != null) out[ch] = series[ch][k];
      if (out.ele != null) out.eleS = eleText[k] != null ? eleText[k] : String(out.ele);
      return out;
    });

    return { points, fills, borrowed, inserted, plan, stats: computeStats(points) };
  }

  // ---------- stats ----------

  function computeStats(pts) {
    const s = { points: pts.length, coverage: {} };
    for (const c of CHANNELS) s.coverage[c] = pts.filter(p => p[c] != null).length;
    if (!pts.length) return s;
    s.start = pts[0].t;
    s.end = pts[pts.length - 1].t;
    s.elapsed = s.end - s.start;
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += haversine(pts[i - 1], pts[i]);
    s.distance = dist;

    const pw = pts.filter(p => p.power != null).map(p => p.power);
    if (pw.length) {
      s.avgPower = mean(pw);
      s.maxPower = Math.max(...pw);
      if (pw.length >= 30) {
        let roll = 0, acc = 0, n = 0;
        for (let i = 0; i < pw.length; i++) {
          roll += pw[i];
          if (i >= 30) roll -= pw[i - 30];
          if (i >= 29) { acc += (roll / 30) ** 4; n++; }
        }
        s.np = (acc / n) ** 0.25;
      }
    }
    const hr = pts.filter(p => p.hr != null).map(p => p.hr);
    if (hr.length) { s.avgHr = mean(hr); s.maxHr = Math.max(...hr); }
    const cad = pts.filter(p => p.cad > 0).map(p => p.cad);
    if (cad.length) s.avgCad = mean(cad);
    if (s.np && s.avgHr) s.ef = s.np / s.avgHr;

    // Climbing with a 2 m hysteresis to ignore sensor noise.
    let gain = 0, ref = null;
    for (const p of pts) {
      if (p.ele == null) continue;
      if (ref == null) ref = p.ele;
      else if (p.ele - ref > 2) { gain += p.ele - ref; ref = p.ele; }
      else if (ref - p.ele > 2) ref = p.ele;
    }
    s.gain = gain;
    return s;
  }

  function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

  // ---------- chart data ----------

  // Per-minute averages of one channel across the merged ride.
  function perMinute(points, ch) {
    if (!points.length) return [];
    const t0 = points[0].t, out = [];
    for (const p of points) {
      if (p[ch] == null) continue;
      const m = Math.floor((p.t - t0) / 60);
      (out[m] = out[m] || []).push(p[ch]);
    }
    const len = Math.floor((points[points.length - 1].t - t0) / 60) + 1;
    return Array.from({ length: len }, (_, m) => (out[m] ? mean(out[m]) : null));
  }

  // A two-minute window, picked where the base file stops and starts the most,
  // with the other file drawn on its raw clock and on the corrected clock.
  function alignmentWindow(files, plan, otherIdx, span = 120) {
    const base = files[plan.base], other = files[otherIdx];
    const key = plan.detected[otherIdx] && plan.detected[otherIdx].method === 'speed' ? 'speed' : 'cad';
    if (key === 'speed') { ensureSpeed(base); ensureSpeed(other); }
    if (!base.pts.some(p => p[key] != null) || !other.pts.some(p => p[key] != null)) return null;
    const bmap = shiftedIndex(base, 0), raw = shiftedIndex(other, 0), fixed = shiftedIndex(other, plan.offsets[otherIdx] || 0);
    let bestStart = base.start, bestScore = -1;
    for (let s = base.start; s + span <= base.end; s += 30) {
      let score = 0, prev = null;
      for (let t = s; t < s + span; t++) {
        const v = bmap.get(t) && bmap.get(t)[key];
        if (v == null || !fixed.has(t)) continue;
        const moving = key === 'cad' ? v > 30 : v > 2;
        if (prev != null && moving !== prev) score++;
        prev = moving;
      }
      if (score > bestScore) { bestScore = score; bestStart = s; }
    }
    const pick = (m, t) => { const p = m.get(t); return p && p[key] != null ? (key === 'speed' ? p[key] * 3.6 : p[key]) : null; };
    const out = { key, start: bestStart, base: [], raw: [], fixed: [] };
    for (let t = bestStart; t < bestStart + span; t++) {
      out.base.push(pick(bmap, t));
      out.raw.push(pick(raw, t));
      out.fixed.push(pick(fixed, t));
    }
    return out;
  }

  // ---------- writing ----------

  function writeGPX(result, meta) {
    const pts = result.points;
    const o = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx creator="' + escapeXml(meta.creator || 'GPX Merge') + '" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd"' +
        ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
      ' <metadata>',
      '  <time>' + (pts.length ? pts[0].timeS : isoSecond(Date.now() / 1000 | 0)) + '</time>',
      ' </metadata>',
      ' <trk>',
      '  <name>' + escapeXml(meta.name || 'Merged ride') + '</name>',
      '  <type>' + escapeXml(meta.type || 'cycling') + '</type>',
      '  <trkseg>',
    ];
    for (const p of pts) {
      o.push('   <trkpt lat="' + p.latS + '" lon="' + p.lonS + '">');
      if (p.ele != null) o.push('    <ele>' + p.eleS + '</ele>');
      o.push('    <time>' + p.timeS + '</time>');
      const tpx = [];
      if (p.atemp != null) tpx.push('      <gpxtpx:atemp>' + p.atemp + '</gpxtpx:atemp>');
      if (p.hr != null) tpx.push('      <gpxtpx:hr>' + p.hr + '</gpxtpx:hr>');
      if (p.cad != null) tpx.push('      <gpxtpx:cad>' + p.cad + '</gpxtpx:cad>');
      if (p.power != null || tpx.length) {
        o.push('    <extensions>');
        // Bare <power> is the form Strava itself exports and reads back.
        if (p.power != null) o.push('     <power>' + p.power + '</power>');
        if (tpx.length) o.push('     <gpxtpx:TrackPointExtension>', ...tpx, '     </gpxtpx:TrackPointExtension>');
        o.push('    </extensions>');
      }
      o.push('   </trkpt>');
    }
    o.push('  </trkseg>', ' </trk>', '</gpx>', '');
    return o.join('\n');
  }

  const API = {
    CHANNELS, CHANNEL_LABELS, CHANNEL_UNITS,
    parseFile, parseGPX, parseFIT, detectOffset, autoPlan, planOffsets, merge, computeStats, perMinute, alignmentWindow, writeGPX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.GPXMerge = API;
})(typeof window !== 'undefined' ? window : globalThis);
