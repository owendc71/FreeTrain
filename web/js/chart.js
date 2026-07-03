/**
 * WorkoutChart – Canvas-based power histogram like TrainerRoad.
 *
 * Usage:
 *   const chart = new WorkoutChart(canvasEl, { ftp: 250 });
 *   chart.setIntervals(intervals);        // array of {duration, power_pct, name?}
 *   chart.tick(elapsed, currentPower);    // call every second during a workout
 *   chart.reset();
 */
class WorkoutChart {
  // Zone thresholds as fraction of FTP, and their colours
  static ZONES = [
    { max: 0.55, color: '#64748b', name: 'Z1' },
    { max: 0.76, color: '#3b82f6', name: 'Z2' },
    { max: 0.90, color: '#22c55e', name: 'Z3' },
    { max: 1.05, color: '#eab308', name: 'Z4' },
    { max: 1.20, color: '#f97316', name: 'Z5' },
    { max: 1.50, color: '#ef4444', name: 'Z6' },
    { max: Infinity, color: '#a855f7', name: 'Z7' },
  ];

  static zoneColor(pct) {
    for (const z of WorkoutChart.ZONES) {
      if (pct < z.max) return z.color;
    }
    return '#9900cc';
  }

  static zoneName(pct) {
    for (const z of WorkoutChart.ZONES) {
      if (pct < z.max) return z.name;
    }
    return 'Z7';
  }

  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.ftp    = opts.ftp || 250;

    // display ceiling: 160% FTP or the highest interval, whichever is larger
    this._maxPct    = 1.60;
    this._intervals = [];     // [{duration, power_pct, name}]
    this._elapsed   = null;   // seconds into workout
    this._powerBuf  = [];     // [{t, w}]  rolling 5-min power trace

    this._pad = { top: 24, right: 20, bottom: 36, left: 58 };
    this._setupResize();
  }

  /* ── public API ─────────────────────────────────────────── */

  setFTP(ftp) {
    this.ftp = ftp;
    this._recalcMax();
    this.draw();
  }

  setIntervals(intervals) {
    this._intervals = intervals;
    this._recalcMax();
    this._powerBuf  = [];
    this._elapsed   = null;
    this.draw();
  }

  tick(elapsedSec, powerWatts) {
    this._elapsed = elapsedSec;
    if (powerWatts != null) {
      this._powerBuf.push({ t: elapsedSec, w: powerWatts });
      // keep 5 min
      const cut = elapsedSec - 300;
      this._powerBuf = this._powerBuf.filter(p => p.t >= cut);
    }
    this.draw();
  }

  reset() {
    this._elapsed  = null;
    this._powerBuf = [];
    this.draw();
  }

  /* ── internals ──────────────────────────────────────────── */

  _recalcMax() {
    const m = this._intervals.reduce((a, iv) => Math.max(a, iv.power_pct), 1.05);
    this._maxPct = Math.max(1.60, m + 0.10);
  }

  _setupResize() {
    const ro = new ResizeObserver(() => {
      const { width } = this.canvas.getBoundingClientRect();
      const h = Math.max(180, Math.round(width * 0.28));
      this.canvas.width  = width * devicePixelRatio;
      this.canvas.height = h    * devicePixelRatio;
      this.canvas.style.height = h + 'px';
      this.ctx.scale(devicePixelRatio, devicePixelRatio);
      this.draw();
    });
    ro.observe(this.canvas.parentElement);
  }

  get _W() { return this.canvas.width  / devicePixelRatio; }
  get _H() { return this.canvas.height / devicePixelRatio; }

  draw() {
    const { ctx, _pad: P } = this;
    const W  = this._W;
    const H  = this._H;
    const cW = W - P.left - P.right;
    const cH = H - P.top  - P.bottom;

    // background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    if (!this._intervals.length) return;

    const total = this._intervals.reduce((s, iv) => s + iv.duration, 0);
    const maxP  = this.ftp * this._maxPct;

    const xOf  = t => P.left + (t / total) * cW;
    const yOf  = w => P.top  + cH - (w / maxP) * cH;

    // ── zone guide lines ──
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.05)';
    ctx.lineWidth   = 1;
    for (const z of WorkoutChart.ZONES) {
      if (z.max === Infinity) break;
      const y = yOf(z.max * this.ftp);
      ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + cW, y); ctx.stroke();
    }
    ctx.restore();

    // ── FTP reference line ──
    ctx.save();
    ctx.strokeStyle = 'rgba(21,128,61,0.35)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 5]);
    const ftpY = yOf(this.ftp);
    ctx.beginPath(); ctx.moveTo(P.left, ftpY); ctx.lineTo(P.left + cW, ftpY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(21,128,61,0.55)';
    ctx.font      = '10px Inter, -apple-system, sans-serif';
    ctx.fillText('FTP', P.left + 4, ftpY - 4);
    ctx.restore();

    // ── Interval bars ──
    let tOff = 0;
    for (const iv of this._intervals) {
      const x   = xOf(tOff);
      const w   = xOf(tOff + iv.duration) - x;
      const pxH = (iv.power_pct / this._maxPct) * cH;
      const y   = P.top + cH - pxH;

      const col = WorkoutChart.zoneColor(iv.power_pct);

      // light tint fill
      ctx.fillStyle = col + '28';
      ctx.fillRect(x, y, w, pxH);

      // solid top cap
      ctx.fillStyle = col;
      ctx.fillRect(x, y, w, 3);

      tOff += iv.duration;
    }

    // ── Interval separators ──
    tOff = 0;
    for (let i = 0; i < this._intervals.length - 1; i++) {
      tOff += this._intervals[i].duration;
      const x = xOf(tOff);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 1, P.top, 2, cH);
    }

    // ── Current-interval highlight ──
    if (this._elapsed !== null) {
      let cumT = 0;
      for (const iv of this._intervals) {
        if (this._elapsed < cumT + iv.duration) {
          const x   = xOf(cumT);
          const w   = xOf(cumT + iv.duration) - x;
          const pxH = (iv.power_pct / this._maxPct) * cH;
          const y   = P.top + cH - pxH;
          ctx.fillStyle = 'rgba(0,0,0,0.03)';
          ctx.fillRect(x, y, w, pxH);
          break;
        }
        cumT += iv.duration;
      }
    }

    // ── Power trace (green) ──
    if (this._powerBuf.length > 1) {
      ctx.save();
      ctx.beginPath();
      let first = true;
      for (const p of this._powerBuf) {
        const px = xOf(p.t);
        const py = Math.max(P.top, yOf(p.w));
        if (first) { ctx.moveTo(px, py); first = false; }
        else        ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(21,128,61,0.90)';
      ctx.lineWidth   = 2;
      ctx.lineJoin    = 'round';
      ctx.stroke();

      const lastP = this._powerBuf[this._powerBuf.length - 1];
      ctx.lineTo(xOf(lastP.t), P.top + cH);
      ctx.lineTo(xOf(this._powerBuf[0].t), P.top + cH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(21,128,61,0.07)';
      ctx.fill();
      ctx.restore();
    }

    // ── Current-time cursor ──
    if (this._elapsed !== null && this._elapsed <= total) {
      const x = xOf(this._elapsed);
      ctx.save();
      ctx.strokeStyle = '#15803d';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, P.top);
      ctx.lineTo(x, P.top + cH);
      ctx.stroke();
      ctx.fillStyle = '#15803d';
      ctx.beginPath();
      ctx.moveTo(x - 5, P.top);
      ctx.lineTo(x + 5, P.top);
      ctx.lineTo(x, P.top + 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ── Y-axis labels ──
    ctx.save();
    ctx.fillStyle = '#8faa8f';
    ctx.font      = '11px Inter, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    const yStep = cH < 180 ? 0.50 : 0.25;
    for (let pct = 0; pct <= this._maxPct + 0.01; pct += yStep) {
      const w   = Math.round(pct * this.ftp);
      const y   = yOf(pct * this.ftp);
      if (y < P.top - 2 || y > P.top + cH + 2) continue;
      ctx.fillText(w + 'W', P.left - 6, y + 4);
      ctx.strokeStyle = 'rgba(0,0,0,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P.left - 3, y);
      ctx.lineTo(P.left, y);
      ctx.stroke();
    }
    ctx.restore();

    // ── X-axis labels ──
    ctx.save();
    ctx.fillStyle = '#8faa8f';
    ctx.font      = '11px Inter, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const nLabels  = Math.min(10, Math.floor(cW / 70));
    const stepSec  = total / nLabels;
    for (let i = 0; i <= nLabels; i++) {
      const t    = i * stepSec;
      const x    = xOf(t);
      const mins = Math.floor(t / 60);
      const secs = Math.round(t % 60);
      const lbl  = secs === 0 ? `${mins}m` : `${mins}:${String(secs).padStart(2, '0')}`;
      ctx.fillText(lbl, x, P.top + cH + 24);
    }
    ctx.restore();

    // ── Axes ──
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(P.left, P.top);
    ctx.lineTo(P.left, P.top + cH);
    ctx.lineTo(P.left + cW, P.top + cH);
    ctx.stroke();
    ctx.restore();
  }
}
