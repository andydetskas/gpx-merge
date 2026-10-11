// Minimal canvas line chart with a hover crosshair and tooltip. No dependencies.
(function (root) {
  'use strict';

  const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw || 1));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
    if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
    return out;
  }

  // cfg: { labels: [], series: [{ label, data, color (CSS var name), dash, width, fill }], unit, yMin }
  function lineChart(canvas, cfg) {
    const wrap = canvas.parentElement;
    let tip = wrap.querySelector('.tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; wrap.appendChild(tip); }
    const pad = { l: 40, r: 10, t: 10, b: 24 };
    const n = cfg.labels.length;
    let W = 0, H = 0, x, y;

    function draw(hover) {
      const dpr = window.devicePixelRatio || 1;
      W = wrap.clientWidth; H = wrap.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const vals = cfg.series.flatMap(s => s.data.filter(v => v != null));
      if (!vals.length) return;
      let lo = cfg.yMin != null ? cfg.yMin : Math.min(...vals), hi = Math.max(...vals);
      if (hi === lo) hi = lo + 1;
      const ticks = niceTicks(lo, hi, 4);
      lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
      x = i => pad.l + (W - pad.l - pad.r) * (n <= 1 ? 0 : i / (n - 1));
      y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));

      ctx.font = '11px ' + token('--font');
      ctx.fillStyle = token('--muted');
      ctx.strokeStyle = token('--grid');
      ctx.lineWidth = 1;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (const tv of ticks) {
        const yy = Math.round(y(tv)) + 0.5;
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
        ctx.fillText(String(tv), pad.l - 6, yy);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - pad.l) / 70))));
      for (let i = 0; i < n; i += every) ctx.fillText(cfg.labels[i], x(i), H - pad.b + 7);

      for (const s of cfg.series) {
        const color = token(s.color);
        ctx.strokeStyle = color; ctx.lineWidth = s.width || 2;
        ctx.setLineDash(s.dash || []); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        let pen = false;
        s.data.forEach((v, i) => {
          if (v == null) { pen = false; return; }
          if (pen) ctx.lineTo(x(i), y(v)); else { ctx.moveTo(x(i), y(v)); pen = true; }
        });
        ctx.stroke();
        if (s.fill) {
          ctx.save(); ctx.globalAlpha = 0.1; ctx.fillStyle = color;
          let start = null;
          const close = end => { ctx.lineTo(x(end), y(lo)); ctx.lineTo(x(start), y(lo)); ctx.closePath(); ctx.fill(); start = null; };
          s.data.forEach((v, i) => {
            if (v == null) { if (start != null) close(i - 1); return; }
            if (start == null) { start = i; ctx.beginPath(); ctx.moveTo(x(i), y(lo)); }
            ctx.lineTo(x(i), y(v));
          });
          if (start != null) close(n - 1);
          ctx.restore();
        }
      }
      ctx.setLineDash([]);

      if (hover == null) { tip.style.display = 'none'; return; }
      const hx = x(hover);
      ctx.strokeStyle = token('--axis'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, pad.t); ctx.lineTo(Math.round(hx) + 0.5, H - pad.b); ctx.stroke();
      const rows = [];
      for (const s of cfg.series) {
        const v = s.data[hover];
        if (v == null) continue;
        ctx.fillStyle = token(s.color); ctx.strokeStyle = token('--surface'); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(hx, y(v), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        rows.push('<div><span class="sw" style="background:var(' + s.color + ')"></span>' + s.label + ' <b>' + Math.round(v) + ' ' + cfg.unit + '</b></div>');
      }
      tip.innerHTML = '<div class="tip-h">' + cfg.labels[hover] + '</div>' + (rows.join('') || '<div>No data</div>');
      tip.style.display = 'block';
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(hx + 12, 0), W - tw) + (hx + 12 + tw > W ? -(tw + 24) : 0) + 'px';
      tip.style.top = pad.t + 'px';
    }

    const pick = e => {
      const r = canvas.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left) - pad.l) / (W - pad.l - pad.r) * (n - 1));
      return Math.min(n - 1, Math.max(0, i));
    };
    canvas.onpointermove = e => draw(pick(e));
    canvas.onpointerleave = () => draw(null);
    draw(null);
    return { redraw: () => draw(null) };
  }

  root.Plot = { lineChart };
})(window);
