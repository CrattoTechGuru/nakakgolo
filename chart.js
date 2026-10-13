/* NakaKgolo mini chart: a dependency-free line chart drawn on <canvas>.
   Replaces Chart.js so the dashboard works fully offline. */
(function (global) {
  'use strict';

  function compact(v) {
    const a = Math.abs(v);
    if (a >= 10000) return (v / 1000).toFixed(0) + 'k';
    if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (a >= 10) return v.toFixed(0);
    return v.toFixed(2);
  }

  class MiniChart {
    constructor(canvas, opts) {
      opts = opts || {};
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.color = opts.color || '#3b82f6';
      this.fill = opts.fill !== false;
      this.points = opts.points === true;
      this.zeroLine = opts.zeroLine === true;
      this.data = [];
    }

    setData(data) {
      this.data = data;
      this.draw();
    }

    draw() {
      const canvas = this.canvas;
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return; // not visible yet; drawn again when the dashboard shows

      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const d = this.data;
      if (!d.length) {
        ctx.fillStyle = '#64748b';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText('No data yet', 40, h / 2);
        return;
      }

      const pad = { l: 40, r: 8, t: 6, b: 14 };
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of d) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
      if (this.zeroLine) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
      if (y0 === y1) { y0 -= 1; y1 += 1; }
      else { const m = (y1 - y0) * 0.08; y0 -= m; y1 += m; }
      if (x0 === x1) x1 = x0 + 1;

      const plotW = w - pad.l - pad.r;
      const plotH = h - pad.t - pad.b;
      const X = x => pad.l + ((x - x0) / (x1 - x0)) * plotW;
      const Y = y => pad.t + (1 - (y - y0) / (y1 - y0)) * plotH;

      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        const v = y0 + ((y1 - y0) * i) / 3;
        const yy = Y(v);
        ctx.strokeStyle = '#151f32';
        ctx.beginPath();
        ctx.moveTo(pad.l, yy);
        ctx.lineTo(w - pad.r, yy);
        ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.fillText(compact(v), pad.l - 4, yy);
      }

      if (this.zeroLine && y0 < 0 && y1 > 0) {
        ctx.strokeStyle = '#334155';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(pad.l, Y(0));
        ctx.lineTo(w - pad.r, Y(0));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = '#64748b';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText('R' + x0, pad.l, h - 2);
      ctx.textAlign = 'right';
      ctx.fillText('R' + x1, w - pad.r, h - 2);

      if (this.fill && d.length > 1) {
        ctx.beginPath();
        ctx.moveTo(X(d[0].x), Y(y0));
        for (const p of d) ctx.lineTo(X(p.x), Y(p.y));
        ctx.lineTo(X(d[d.length - 1].x), Y(y0));
        ctx.closePath();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = this.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.beginPath();
      d.forEach((p, i) => {
        if (i) ctx.lineTo(X(p.x), Y(p.y));
        else ctx.moveTo(X(p.x), Y(p.y));
      });
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();

      if (this.points) {
        ctx.fillStyle = this.color;
        for (const p of d) {
          ctx.beginPath();
          ctx.arc(X(p.x), Y(p.y), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  global.MiniChart = MiniChart;
})(window);
