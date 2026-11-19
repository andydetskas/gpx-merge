// UI: file loading, plan controls, preview and download.
(function () {
  'use strict';
  const G = window.GPXMerge;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // result: the merge the preview shows (GPX when any file has GPS, else FIT). fit: the FIT merge,
  // which also keeps seconds without a position.
  const state = { files: [], plan: null, result: null, fit: null, charts: [] };

  // ---------- formatting ----------

  const clock = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const clockShort = t => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = t => {
    const d = new Date(t * 1000);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };
  const duration = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + ' min'; };
  const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + ' s';
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0) + '%';
  const METHOD = { cad: 'cadence', speed: 'speed', power: 'power' };
  const ALIGN_UNIT = { cad: 'rpm', speed: 'km/h', power: 'W' };
  const hasGPS = () => state.files.some(f => f.located);

  function shortName(f) {
    return f.fileName.replace(/\.(gpx|fit)$/i, '');
  }

  // ---------- loading ----------

  async function readFile(file) {
    // A long ride is a few MB as FIT, tens of MB as GPX. Anything far bigger was dropped by mistake.
    if (file.size > 200e6) throw new Error('Too large to be a ride recording.');
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // Gzipped, as in a Strava bulk export (ride.fit.gz).
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return G.parseFile(bytes, file.name.replace(/\.gz$/i, ''));
  }

  async function handleFiles(list) {
    const errors = [];
    for (const file of list) {
      try {
        state.files.push(await readFile(file));
      } catch (e) {
        errors.push(file.name + ': ' + e.message);
      }
    }
    showError(errors.join(' '));
    replan();
  }

  function showError(msg) {
    $('error').textContent = msg;
    $('error').hidden = !msg;
  }

  function replan() {
    state.plan = state.files.length ? G.autoPlan(state.files) : null;
    render();
  }

  // ---------- rendering ----------

  function render() {
    const has = state.files.length > 0, gps = hasGPS();
    $('demo-line').hidden = has;
    $('files-section').hidden = !has;
    $('sources-section').hidden = !has;
    $('preview-section').hidden = !has;
    // With no GPS anywhere there is no track for a GPX file: FIT only.
    $('no-gps').hidden = !has || gps;
    $('download').hidden = !gps;
    $('download-fit').className = gps ? 'secondary' : 'primary';
    if (!has) return;
    renderFiles();
    renderSources();
    runMerge();
  }

  function renderFiles() {
    const { files, plan } = state;
    const gps = hasGPS();
    const rows = files.map((f, i) => {
      const chips = G.CHANNELS.filter(c => f.coverage[c]).map(c => '<span class="chip">' + G.CHANNEL_LABELS[c] + '</span>').join('');
      const d = plan.detected[i];
      const note = i === plan.base ? 'base clock' : d.method === 'none' ? 'no overlap found' : 'auto ' + signed(d.offset) + ' (' + METHOD[d.method] + ')';
      const noFix = f.pts.length - f.located;
      const notes = [
        f.gaps && f.gaps + ' gaps, ' + f.gapSeconds + ' s',
        noFix && (f.located ? noFix.toLocaleString() + ' without GPS' : 'no GPS'),
      ].filter(Boolean);
      return '<tr>' +
        '<td><input type="radio" name="base" value="' + i + '"' + (i === plan.base ? ' checked' : '') + (f.located || !gps ? '' : ' disabled') + ' aria-label="Use as base"></td>' +
        '<td class="name">' + esc(shortName(f)) + '<small>' + esc(f.creator || 'Unknown app') + ' · ' + f.format.toUpperCase() + '</small></td>' +
        '<td>' + day(f.start) + '<br>' + clock(f.start) + ' – ' + clock(f.end) + '</td>' +
        '<td>' + f.pts.length.toLocaleString() + notes.map(n => '<br><small>' + n + '</small>').join('') + '</td>' +
        '<td><div class="chips">' + chips + '</div></td>' +
        '<td><div class="offset"><input type="number" step="1" data-offset="' + i + '" value="' + (plan.offsets[i] || 0) + '"' + (i === plan.base ? ' disabled' : '') + ' aria-label="Clock offset in seconds"><small>' + note + '</small></div></td>' +
        '<td><button class="icon" data-remove="' + i + '" aria-label="Remove ' + esc(f.fileName) + '">×</button></td>' +
        '</tr>';
    });
    $('files').innerHTML = '<thead><tr><th>Base</th><th>File</th><th>Recorded</th><th>Points</th><th>Data</th><th>Clock offset</th><th></th></tr></thead><tbody>' + rows.join('') + '</tbody>';
  }

  function renderSources() {
    const { files, plan } = state;
    $('sources').innerHTML = G.CHANNELS.map(ch => {
      const opts = files.map((f, i) => f.coverage[ch]
        ? '<option value="' + i + '"' + (plan.sources[ch] === i ? ' selected' : '') + '>' + esc(shortName(f)) + ' (' + pct(f.coverage[ch], f.pts.length) + ')</option>'
        : '').join('');
      return '<div class="source"><label for="src-' + ch + '">' + G.CHANNEL_LABELS[ch] + '</label>' +
        '<select id="src-' + ch + '" data-source="' + ch + '"><option value=""' + (plan.sources[ch] == null ? ' selected' : '') + '>None</option>' + opts + '</select></div>';
    }).join('');
    $('maxfill').value = plan.maxFill;
    $('filltimeline').checked = plan.fillTimeline;
    $('ridename').value = plan.name;
  }

  function runMerge() {
    const { files, plan } = state;
    state.fit = G.merge(files, plan, { format: 'fit' });
    state.result = hasGPS() ? G.merge(files, plan) : state.fit;
    renderPreview();
  }

  function renderPreview() {
    const { files, plan, result } = state;
    const s = result.stats;
    const tiles = [
      ['Elapsed', duration(s.elapsed)],
      s.distance > 0 && ['Distance', (s.distance / 1609.344).toFixed(2) + ' mi'],
      s.avgPower != null && ['Avg / NP power', Math.round(s.avgPower) + ' / ' + (s.np ? Math.round(s.np) : '–') + ' W'],
      s.maxPower != null && ['Max power', Math.round(s.maxPower) + ' W'],
      s.avgHr != null && ['Avg / max HR', Math.round(s.avgHr) + ' / ' + Math.round(s.maxHr)],
      s.avgCad != null && ['Avg cadence', Math.round(s.avgCad) + ' rpm'],
      s.coverage.ele > 0 && ['Climbing (approx.)', Math.round(s.gain * 3.281).toLocaleString() + ' ft'],
      s.ef != null && ['Efficiency (NP/HR)', s.ef.toFixed(2)],
    ].filter(Boolean);
    $('kpis').innerHTML = tiles.map(([k, v]) => '<div class="kpi"><span>' + k + '</span><b>' + v + '</b></div>').join('');

    state.charts = [];
    const alignHtml = [], alignData = [];
    files.forEach((f, i) => {
      if (i === plan.base) return;
      const w = G.alignmentWindow(files, plan, i);
      if (!w) return;
      const unit = METHOD[w.key];
      alignHtml.push('<div class="chart-block"><p class="chart-title">Clock check: ' + esc(shortName(f)) + ' vs ' + esc(shortName(files[plan.base])) + '</p>' +
        '<p class="chart-sub">Two minutes of ' + unit + ' from ' + clock(w.start) + '. The corrected line should rise and fall with the base.</p>' +
        '<div class="legend"><span><i style="border-color:var(--s1)"></i>' + esc(shortName(files[plan.base])) + ' (base)</span>' +
        '<span><i style="border-color:var(--s2);border-top-style:dashed"></i>' + esc(shortName(f)) + ', shifted ' + signed(plan.offsets[i] || 0) + '</span>' +
        '<span><i style="border-color:var(--s3);border-top-style:dotted"></i>' + esc(shortName(f)) + ', raw clock</span></div>' +
        '<div class="chart"><canvas role="img" aria-label="' + unit + ' alignment chart"></canvas></div></div>');
      alignData.push(w);
    });
    $('align').innerHTML = alignHtml.join('');
    $('align').querySelectorAll('canvas').forEach((cv, k) => {
      const w = alignData[k];
      state.charts.push(Plot.lineChart(cv, {
        labels: w.base.map((_, j) => clock(w.start + j)),
        unit: ALIGN_UNIT[w.key],
        yMin: 0,
        series: [
          { label: 'Raw', data: w.raw, color: '--s3', dash: [2, 4], width: 1.5 },
          { label: 'Base', data: w.base, color: '--s1' },
          { label: 'Shifted', data: w.fixed, color: '--s2', dash: [6, 4] },
        ],
      }));
    });

    const over = [];
    const t0 = result.points.length ? result.points[0].t : 0;
    for (const [ch, title, yMin] of [['power', 'Power', 0], ['hr', 'Heart rate', null]]) {
      if (!s.coverage[ch]) continue;
      const src = plan.sources[ch];
      over.push({ ch, yMin, html: '<div class="chart-block"><p class="chart-title">' + title + ', per minute</p><p class="chart-sub">From ' + esc(shortName(files[src])) + '</p><div class="chart short"><canvas role="img" aria-label="' + title + ' per minute"></canvas></div></div>' });
    }
    $('overview').innerHTML = over.map(o => o.html).join('');
    $('overview').querySelectorAll('canvas').forEach((cv, k) => {
      const o = over[k], data = G.perMinute(result.points, o.ch);
      state.charts.push(Plot.lineChart(cv, {
        labels: data.map((_, m) => clockShort(t0 + m * 60)),
        unit: G.CHANNEL_UNITS[o.ch],
        yMin: o.yMin,
        series: [{ label: G.CHANNEL_LABELS[o.ch], data, color: '--s1', fill: true }],
      }));
    });

    renderFills();

    const missing = G.CHANNELS.filter(c => plan.sources[c] != null && s.coverage[c] < s.points)
      .map(c => G.CHANNEL_LABELS[c].toLowerCase() + ' on ' + (s.points - s.coverage[c]).toLocaleString());
    const noFix = result === state.fit ? 0 : state.fit.points.filter(p => p.lat == null).length;
    $('download-note').textContent = s.points.toLocaleString() + ' points' +
      (result.inserted ? ', ' + result.inserted.toLocaleString() + ' taken from other files' : '') +
      (missing.length ? '. Still blank: ' + missing.join(', ') + ' points.' : '. No blanks.') +
      (noFix ? ' The FIT also keeps ' + noFix.toLocaleString() + (noFix === 1 ? ' second' : ' seconds') + ' recorded without GPS.' : '');
  }

  function renderFills() {
    const { result } = state;
    const fills = result.fills;
    const counts = {};
    for (const f of fills) {
      const key = G.CHANNEL_LABELS[f.ch] + (f.how === 'coast' ? ' (coast → 0)' : '');
      counts[key] = (counts[key] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, n]) => k + ': ' + n).join(' · ');
    const lent = Object.entries(result.borrowed).map(([ch, n]) => G.CHANNEL_LABELS[ch] + ': ' + n.toLocaleString()).join(' · ');
    $('fills').innerHTML = '<summary>' + (fills.length ? fills.length + ' readings filled in' : 'No gaps filled') +
      (lent ? ', plus readings borrowed from other files' : '') + '</summary>' +
      (lent ? '<p class="hint" style="margin:8px 0 0">Borrowed where the chosen source had nothing: ' + lent + '</p>' : '') +
      (fills.length ? '<p class="hint" style="margin:8px 0 0">Filled: ' + summary + '</p><ul>' +
        fills.map(f => '<li>' + clock(f.t) + ' · ' + G.CHANNEL_LABELS[f.ch] + ' ' + f.value + ' ' + G.CHANNEL_UNITS[f.ch] + (f.how === 'coast' ? ' (coast)' : '') + '</li>').join('') + '</ul>' : '');
  }

  // ---------- events ----------

  const drop = $('drop');
  $('picker').addEventListener('change', e => { handleFiles([...e.target.files]); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  // Every dropped file is passed on: one that isn't GPX or FIT gets an error that says so.
  drop.addEventListener('drop', e => handleFiles([...e.dataTransfer.files]));
  // Stop a stray drop elsewhere from opening the file in the tab.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  // Sample recordings, made in the page by js/sample.js (loaded on first use).
  async function loadSamples(make) {
    try {
      if (!window.GPXSample) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'js/sample.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('Couldn\'t load the sample recordings.'));
          document.head.appendChild(s);
        });
      }
      const start = new Date();
      start.setHours(7, 30, 0, 0);
      state.files = [];
      await handleFiles(make(window.GPXSample)(start / 1000).map(f => new File([f.data], f.name)));
    } catch (e) {
      showError(e.message);
    }
  }
  $('demo').addEventListener('click', () => loadSamples(S => S.demoFiles));
  $('demo-indoor').addEventListener('click', () => loadSamples(S => S.indoorDemoFiles));

  $('files').addEventListener('change', e => {
    const { plan, files } = state;
    if (e.target.name === 'base') {
      plan.base = +e.target.value;
      G.planOffsets(files, plan);
      render();
    } else if (e.target.dataset.offset != null) {
      plan.offsets[+e.target.dataset.offset] = Math.round(+e.target.value || 0);
      runMerge();
    }
  });
  $('files').addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    state.files.splice(+btn.dataset.remove, 1);
    replan();
  });
  $('sources').addEventListener('change', e => {
    const ch = e.target.dataset.source;
    state.plan.sources[ch] = e.target.value === '' ? null : +e.target.value;
    runMerge();
  });
  $('maxfill').addEventListener('change', e => { state.plan.maxFill = Math.max(0, Math.round(+e.target.value || 0)); runMerge(); });
  $('filltimeline').addEventListener('change', e => { state.plan.fillTimeline = e.target.checked; runMerge(); });
  $('ridename').addEventListener('input', e => { state.plan.name = e.target.value; });

  // The merged file is described as coming from the base recording's device.
  function outputMeta() {
    const { files, plan } = state, base = files[plan.base];
    return { name: plan.name, creator: base.creator, type: base.type, device: base.device, sport: base.sport, subSport: base.subSport, utcOffset: base.utcOffset };
  }

  function save(data, type, ext) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = (state.plan.name || 'ride').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '_merged.' + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('download').addEventListener('click', () => save(G.writeGPX(state.result, outputMeta()), 'application/gpx+xml', 'gpx'));
  $('download-fit').addEventListener('click', () => save(G.writeFIT(state.fit, outputMeta()), 'application/vnd.ant.fit', 'fit'));

  let resizeTimer;
  const redrawAll = () => state.charts.forEach(c => c.redraw());
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawAll, 100); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawAll);

  window.GPXMergeApp = { handleFiles };
})();
