'use strict';

/* ═══════════════════════════════════════════════════════════════════
   TrainingDashboard – training-load, adherence, and zone-distribution
   charts for the Dashboard tab. Canvas bar charts follow the same
   ResizeObserver pattern as WorkoutChart (chart.js).

   Color jobs (see dataviz method):
     Weekly Training Load  – single series, brand accent (green)
     Plan Adherence        – status tiers (good / fair / low), fixed hexes
     Time in Zone           – ordinal single-hue ramp (light→dark = low→high
                              intensity), validated with --ordinal
═══════════════════════════════════════════════════════════════════ */

class TrainingDashboard {
  // Ordinal blue ramp, validated: node scripts/validate_palette.js
  // "#86b6ef,#3987e5,#256abf,#184f95,#0d366b" --mode light --ordinal → PASS
  static ZONE_BUCKETS = [
    { label: 'Recovery / Endurance', max: 0.76,     color: '#86b6ef', textDark: true  },
    { label: 'Tempo',                max: 0.90,     color: '#3987e5', textDark: false },
    { label: 'Threshold',            max: 1.05,     color: '#256abf', textDark: false },
    { label: 'VO2 Max',              max: 1.20,     color: '#184f95', textDark: false },
    { label: 'Anaerobic+',           max: Infinity, color: '#0d366b', textDark: false },
  ];

  static LOAD_COLOR   = '#16a34a';
  static LOAD_HOVER    = '#15803d';
  static STATUS_GOOD   = '#16a34a';
  static STATUS_FAIR   = '#d97706';
  static STATUS_LOW    = '#dc2626';

  // Running gets its own brand accent (teal) so it reads as a distinct
  // discipline from cycling (green) at a glance. Contrast-checked ≥3:1 on white.
  static RUN_COLOR = '#0f766e';
  static RUN_HOVER = '#115e59';

  static M_PER_MILE = 1609.34;

  constructor() {
    this._loadCanvas    = document.getElementById('dash-load-canvas');
    this._adhCanvas     = document.getElementById('dash-adherence-canvas');
    this._zoneBar       = document.getElementById('dash-zone-bar');
    this._zoneLegend    = document.getElementById('dash-zone-legend');
    this._runLoadCanvas = document.getElementById('dash-run-load-canvas');
    this._runAdhCanvas  = document.getElementById('dash-run-adherence-canvas');

    this._rides   = [];
    this._plan    = {};
    this._runs    = [];
    this._runPlan = {};

    if (this._loadCanvas)    this._setupCanvas(this._loadCanvas,    () => this._drawLoad());
    if (this._adhCanvas)     this._setupCanvas(this._adhCanvas,     () => this._drawAdherence());
    if (this._runLoadCanvas) this._setupCanvas(this._runLoadCanvas, () => this._drawRunLoad());
    if (this._runAdhCanvas)  this._setupCanvas(this._runAdhCanvas,  () => this._drawRunAdherence());
  }

  // ── Public ─────────────────────────────────────────────────────────

  update({ rides, plan, runs, runPlan } = {}) {
    if (rides   != null) this._rides   = rides;
    if (plan    != null) this._plan    = plan;
    if (runs    != null) this._runs    = runs;
    if (runPlan != null) this._runPlan = runPlan;
    this.refresh();
  }

  // Call when the Dashboard tab becomes visible (canvases may have been
  // sized 0×0 while hidden; the ResizeObserver re-fires on becoming visible,
  // but we also redraw explicitly for an immediate, reliable refresh).
  refresh() {
    this._drawLoad();
    this._drawAdherence();
    this._drawZones();
    this._drawRunLoad();
    this._drawRunAdherence();
    this._renderRunSummary();
  }

  _renderRunSummary() {
    const el = document.getElementById('run-hs-summary');
    if (!el) return;
    if (!this._runs.length) { el.style.display = 'none'; return; }

    const totalDist = this._runs.reduce((s, r) => s + (r.distance_m || 0), 0);
    const totalElev = this._runs.reduce((s, r) => s + (r.elevation_gain_m || 0), 0);
    const totalSec  = this._runs.reduce((s, r) => s + (r.elapsed || 0), 0);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.round((totalSec % 3600) / 60);

    document.getElementById('run-hs-runs').textContent  = this._runs.length;
    document.getElementById('run-hs-miles').textContent = (totalDist / TrainingDashboard.M_PER_MILE).toFixed(0);
    document.getElementById('run-hs-vert').textContent  = Math.round(totalElev * 3.28084).toLocaleString();
    document.getElementById('run-hs-time').textContent  = hrs ? `${hrs}h ${mins}m` : `${mins}m`;
    el.style.display = 'flex';
  }

  // ── Date helpers ───────────────────────────────────────────────────

  _parseDate(str) {
    if (!str) return null;
    const d = new Date(String(str).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? null : d;
  }

  _weekStart(d) {
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = r.getDay();
    r.setDate(r.getDate() + ((day === 0 ? -6 : 1) - day));   // Monday
    return r;
  }

  _weekLabel(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ── Data prep ──────────────────────────────────────────────────────

  _weeklyBuckets(numWeeks) {
    const curStart = this._weekStart(new Date());
    const weeks = [];
    for (let i = numWeeks - 1; i >= 0; i--) {
      const start = new Date(curStart);
      start.setDate(start.getDate() - i * 7);
      weeks.push({ start, tss: 0, hours: 0, rides: 0 });
    }
    this._rides.forEach(r => {
      const d = this._parseDate(r.date);
      if (!d) return;
      const ws = this._weekStart(d).getTime();
      const bucket = weeks.find(w => w.start.getTime() === ws);
      if (bucket) {
        bucket.tss   += r.tss || 0;
        bucket.hours += (r.elapsed || 0) / 3600;
        bucket.rides += 1;
      }
    });
    return weeks;
  }

  _adherenceBuckets(numWeeks) {
    const todayIso = this._isoLocal(new Date());
    const completedDates = new Set(
      this._rides.filter(r => r.completed).map(r => String(r.date || '').slice(0, 10))
    );

    const curStart = this._weekStart(new Date());
    const weeks = [];
    for (let i = numWeeks - 1; i >= 0; i--) {
      const start = new Date(curStart);
      start.setDate(start.getDate() - i * 7);
      weeks.push({ start, planned: 0, completed: 0 });
    }

    Object.entries(this._plan).forEach(([dateStr, workoutId]) => {
      if (!workoutId || dateStr > todayIso) return;
      const d = this._parseDate(dateStr);
      if (!d) return;
      const ws = this._weekStart(d).getTime();
      const bucket = weeks.find(w => w.start.getTime() === ws);
      if (!bucket) return;
      bucket.planned += 1;
      if (completedDates.has(dateStr)) bucket.completed += 1;
    });

    return weeks
      .filter(w => w.planned > 0)
      .map(w => ({ ...w, pct: Math.round((w.completed / w.planned) * 100) }));
  }

  _isoLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _zoneDistribution() {
    const cutoff = Date.now() - 90 * 86400000;
    const buckets = TrainingDashboard.ZONE_BUCKETS.map(b => ({ ...b, hours: 0 }));
    let totalHours = 0;

    this._rides.forEach(r => {
      if (!r.avg_power || !r.ftp) return;
      const d = this._parseDate(r.date);
      if (d && d.getTime() < cutoff) return;
      const ratio = r.avg_power / r.ftp;
      const bucket = buckets.find(b => ratio < b.max) || buckets[buckets.length - 1];
      const hrs = (r.elapsed || 0) / 3600;
      bucket.hours += hrs;
      totalHours   += hrs;
    });

    return { buckets, totalHours };
  }

  _weeklyRunBuckets(numWeeks) {
    const curStart = this._weekStart(new Date());
    const weeks = [];
    for (let i = numWeeks - 1; i >= 0; i--) {
      const start = new Date(curStart);
      start.setDate(start.getDate() - i * 7);
      weeks.push({ start, distanceM: 0, elevM: 0, runs: 0 });
    }
    this._runs.forEach(r => {
      const d = this._parseDate(r.date);
      if (!d) return;
      const ws = this._weekStart(d).getTime();
      const bucket = weeks.find(w => w.start.getTime() === ws);
      if (bucket) {
        bucket.distanceM += r.distance_m || 0;
        bucket.elevM     += r.elevation_gain_m || 0;
        bucket.runs      += 1;
      }
    });
    return weeks;
  }

  _runAdherenceBuckets(numWeeks) {
    const todayIso = this._isoLocal(new Date());
    const completedByDate = {};
    this._runs.forEach(r => {
      const ds = String(r.date || '').slice(0, 10);
      if (!ds) return;
      completedByDate[ds] = (completedByDate[ds] || 0) + (r.distance_m || 0);
    });

    const curStart = this._weekStart(new Date());
    const weeks = [];
    for (let i = numWeeks - 1; i >= 0; i--) {
      const start = new Date(curStart);
      start.setDate(start.getDate() - i * 7);
      weeks.push({ start, planned: 0, hit: 0 });
    }

    Object.entries(this._runPlan).forEach(([dateStr, entry]) => {
      const target = entry && entry.target_distance_m;
      if (!target || dateStr > todayIso) return;
      const d = this._parseDate(dateStr);
      if (!d) return;
      const ws = this._weekStart(d).getTime();
      const bucket = weeks.find(w => w.start.getTime() === ws);
      if (!bucket) return;
      bucket.planned += 1;
      if ((completedByDate[dateStr] || 0) >= target * 0.85) bucket.hit += 1;
    });

    return weeks
      .filter(w => w.planned > 0)
      .map(w => ({ ...w, pct: Math.round((w.hit / w.planned) * 100) }));
  }

  // ── Weekly Training Load chart ────────────────────────────────────

  _drawLoad() {
    const canvas = this._loadCanvas;
    const empty  = document.getElementById('dash-load-empty');
    const sub    = document.getElementById('dash-load-sub');
    if (!canvas) return;

    const weeks = this._weeklyBuckets(10);
    const hasData = weeks.some(w => w.tss > 0);

    canvas.style.display = hasData ? 'block' : 'none';
    if (empty) empty.style.display = hasData ? 'none' : 'flex';
    if (!hasData) { if (sub) sub.textContent = ''; return; }

    const cur  = weeks[weeks.length - 1];
    const prev = weeks[weeks.length - 2];
    if (sub) {
      if (prev && prev.tss > 0) {
        const delta = Math.round(((cur.tss - prev.tss) / prev.tss) * 100);
        const arrow = delta >= 0 ? '↑' : '↓';
        sub.textContent = `${Math.round(cur.tss)} TSS this week · ${arrow} ${Math.abs(delta)}% vs last week`;
      } else {
        sub.textContent = `${Math.round(cur.tss)} TSS this week`;
      }
    }

    const items = weeks.map((w, i) => ({
      label: this._weekLabel(w.start),
      value: Math.round(w.tss),
      color: TrainingDashboard.LOAD_COLOR,
      hoverColor: TrainingDashboard.LOAD_HOVER,
      tooltip: `${Math.round(w.tss)} TSS · ${w.hours.toFixed(1)} hrs`,
      directLabel: i === weeks.length - 1,
    }));

    this._drawBars(canvas, items);
  }

  // ── Plan Adherence chart ──────────────────────────────────────────

  _drawAdherence() {
    const canvas = this._adhCanvas;
    const empty  = document.getElementById('dash-adherence-empty');
    const sub    = document.getElementById('dash-adherence-sub');
    if (!canvas) return;

    const weeks = this._adherenceBuckets(10);
    const hasData = weeks.length > 0;

    canvas.style.display = hasData ? 'block' : 'none';
    if (empty) empty.style.display = hasData ? 'none' : 'flex';
    if (!hasData) { if (sub) sub.textContent = ''; return; }

    const avg = Math.round(weeks.reduce((s, w) => s + w.pct, 0) / weeks.length);
    if (sub) sub.textContent = `${avg}% average, last ${weeks.length} planned week${weeks.length === 1 ? '' : 's'}`;

    const items = weeks.map((w, i) => {
      const color = w.pct >= 85 ? TrainingDashboard.STATUS_GOOD
                  : w.pct >= 60 ? TrainingDashboard.STATUS_FAIR
                  :                TrainingDashboard.STATUS_LOW;
      return {
        label: this._weekLabel(w.start),
        value: w.pct,
        color,
        hoverColor: color,
        tooltip: `${w.pct}% adherence · ${w.completed}/${w.planned} planned rides`,
        directLabel: i === weeks.length - 1,
        valueSuffix: '%',
      };
    });

    this._drawBars(canvas, items, { maxOverride: 100 });
  }

  // ── Weekly Mileage chart (running) ─────────────────────────────────

  _drawRunLoad() {
    const canvas = this._runLoadCanvas;
    const empty  = document.getElementById('dash-run-load-empty');
    const sub    = document.getElementById('dash-run-load-sub');
    if (!canvas) return;

    const weeks = this._weeklyRunBuckets(10);
    const hasData = weeks.some(w => w.distanceM > 0);

    canvas.style.display = hasData ? 'block' : 'none';
    if (empty) empty.style.display = hasData ? 'none' : 'flex';
    if (!hasData) { if (sub) sub.textContent = ''; return; }

    const cur  = weeks[weeks.length - 1];
    const prev = weeks[weeks.length - 2];
    const curMi = cur.distanceM / TrainingDashboard.M_PER_MILE;
    if (sub) {
      if (prev && prev.distanceM > 0) {
        const delta = Math.round(((cur.distanceM - prev.distanceM) / prev.distanceM) * 100);
        const arrow = delta >= 0 ? '↑' : '↓';
        sub.textContent = `${curMi.toFixed(1)} mi this week · ${arrow} ${Math.abs(delta)}% vs last week`;
      } else {
        sub.textContent = `${curMi.toFixed(1)} mi this week`;
      }
    }

    const items = weeks.map((w, i) => ({
      label: this._weekLabel(w.start),
      value: Math.round((w.distanceM / TrainingDashboard.M_PER_MILE) * 10) / 10,
      color: TrainingDashboard.RUN_COLOR,
      hoverColor: TrainingDashboard.RUN_HOVER,
      tooltip: `${(w.distanceM / TrainingDashboard.M_PER_MILE).toFixed(1)} mi · ${Math.round(w.elevM * 3.28084)} ft vert`,
      directLabel: i === weeks.length - 1,
      valueSuffix: 'mi',
    }));

    this._drawBars(canvas, items);
  }

  // ── Run Plan Adherence chart ───────────────────────────────────────

  _drawRunAdherence() {
    const canvas = this._runAdhCanvas;
    const empty  = document.getElementById('dash-run-adherence-empty');
    const sub    = document.getElementById('dash-run-adherence-sub');
    if (!canvas) return;

    const weeks = this._runAdherenceBuckets(10);
    const hasData = weeks.length > 0;

    canvas.style.display = hasData ? 'block' : 'none';
    if (empty) empty.style.display = hasData ? 'none' : 'flex';
    if (!hasData) { if (sub) sub.textContent = ''; return; }

    const avg = Math.round(weeks.reduce((s, w) => s + w.pct, 0) / weeks.length);
    if (sub) sub.textContent = `${avg}% average, last ${weeks.length} planned week${weeks.length === 1 ? '' : 's'}`;

    const items = weeks.map((w, i) => {
      const color = w.pct >= 85 ? TrainingDashboard.STATUS_GOOD
                  : w.pct >= 60 ? TrainingDashboard.STATUS_FAIR
                  :                TrainingDashboard.STATUS_LOW;
      return {
        label: this._weekLabel(w.start),
        value: w.pct,
        color,
        hoverColor: color,
        tooltip: `${w.pct}% adherence · ${w.hit}/${w.planned} planned runs hit`,
        directLabel: i === weeks.length - 1,
        valueSuffix: '%',
      };
    });

    this._drawBars(canvas, items, { maxOverride: 100 });
  }

  // ── Generic bar chart renderer ────────────────────────────────────

  _setupCanvas(canvas, redraw) {
    const ro = new ResizeObserver(() => {
      const { width } = canvas.getBoundingClientRect();
      if (!width) return;
      const h = 200;
      canvas.width  = width * devicePixelRatio;
      canvas.height = h     * devicePixelRatio;
      canvas.style.height = h + 'px';
      canvas.getContext('2d').setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      redraw();
    });
    ro.observe(canvas.parentElement);

    canvas.addEventListener('mousemove', e => this._onHover(canvas, e));
    canvas.addEventListener('mouseleave', () => this._hideTooltip(canvas));
  }

  _niceMax(raw) {
    if (raw <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (const s of steps) {
      if (raw <= s * mag) return s * mag;
    }
    return 10 * mag;
  }

  _drawBars(canvas, items, opts = {}) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width  / devicePixelRatio;
    const H = canvas.height / devicePixelRatio;
    if (!W || !H) return;

    ctx.clearRect(0, 0, W, H);

    const P = { top: 26, right: 8, bottom: 24, left: 8 };
    const cW = W - P.left - P.right;
    const cH = H - P.top  - P.bottom;

    const rawMax = Math.max(...items.map(i => i.value), 1);
    const maxVal = opts.maxOverride || this._niceMax(rawMax * 1.2);

    const n     = items.length;
    const slot  = cW / n;
    const barW  = Math.min(24, slot * 0.6);

    // gridlines: 0, mid, max — hairline, recessive
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth   = 1;
    [0, 0.5, 1].forEach(f => {
      const y = P.top + cH - f * cH;
      ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(P.left + cW, y); ctx.stroke();
    });
    ctx.restore();

    canvas._bars = [];   // for hover hit-testing

    items.forEach((item, i) => {
      const x = P.left + i * slot + (slot - barW) / 2;
      const barH = Math.max(2, (item.value / maxVal) * cH);
      const y = P.top + cH - barH;

      ctx.fillStyle = item.color;
      this._roundedTopRect(ctx, x, y, barW, barH, 4);
      ctx.fill();

      // x-axis label (thin out if bars are packed tightly)
      const showEveryLabel = slot >= 42 || i % 2 === 0 || i === n - 1;
      if (showEveryLabel) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.font = '10px Inter, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(item.label, x + barW / 2, P.top + cH + 16);
        ctx.restore();
      }

      // selective direct label (e.g. current week)
      if (item.directLabel) {
        ctx.save();
        ctx.fillStyle = '#0d1a0d';
        ctx.font = '700 12px Inter, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${item.value}${item.valueSuffix || ''}`, x + barW / 2, Math.max(14, y - 6));
        ctx.restore();
      }

      canvas._bars.push({ x, y, w: barW, h: barH, item });
    });
  }

  _roundedTopRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  _onHover(canvas, e) {
    const bars = canvas._bars || [];
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const hit = bars.find(b => mx >= b.x - 4 && mx <= b.x + b.w + 4 && my >= b.y - 6 && my <= rect.height);
    if (!hit) { this._hideTooltip(canvas); return; }

    this._showTooltip(canvas, hit.item.tooltip || `${hit.item.value}`, e.clientX, e.clientY);
  }

  _showTooltip(canvas, text, clientX, clientY) {
    let tip = canvas.parentElement.querySelector('.dash-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'dash-tooltip';
      canvas.parentElement.appendChild(tip);
    }
    const wrapRect = canvas.parentElement.getBoundingClientRect();
    tip.textContent = text;
    tip.style.display = 'block';
    tip.style.left = (clientX - wrapRect.left + 12) + 'px';
    tip.style.top  = (clientY - wrapRect.top - 30) + 'px';
  }

  _hideTooltip(canvas) {
    const tip = canvas.parentElement.querySelector('.dash-tooltip');
    if (tip) tip.style.display = 'none';
  }

  // ── Time in Zone (HTML/CSS stacked bar) ───────────────────────────

  _drawZones() {
    if (!this._zoneBar) return;
    const empty = document.getElementById('dash-zone-empty');
    const { buckets, totalHours } = this._zoneDistribution();

    if (totalHours <= 0) {
      this._zoneBar.style.display = 'none';
      this._zoneLegend.innerHTML  = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    this._zoneBar.style.display = 'flex';

    this._zoneBar.innerHTML = buckets
      .filter(b => b.hours > 0)
      .map(b => {
        const pct = (b.hours / totalHours) * 100;
        const showLabel = pct >= 10;
        return `<div class="dash-zone-seg" style="flex:${pct};background:${b.color};color:${b.textDark ? '#0d1a0d' : '#fff'}"
                  title="${b.label}: ${b.hours.toFixed(1)} hrs (${Math.round(pct)}%)">
                  ${showLabel ? Math.round(pct) + '%' : ''}
                </div>`;
      }).join('');

    this._zoneLegend.innerHTML = buckets
      .filter(b => b.hours > 0)
      .map(b => `<span class="dash-legend-item">
                   <span class="dash-legend-dot" style="background:${b.color}"></span>
                   ${b.label} — ${b.hours.toFixed(1)} hrs
                 </span>`).join('');
  }
}

window.TrainingDashboard = TrainingDashboard;
