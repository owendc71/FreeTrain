'use strict';

/* ═══════════════════════════════════════════════════════════════════
   Run tab – career run stats, recent runs list, and the run plan
   generator modal (mirrors PlanGenerator in planner.js, but targets
   mileage instead of power since runs are Strava-import-only).
═══════════════════════════════════════════════════════════════════ */

const M_PER_MILE = 1609.34;
const M_PER_FOOT = 0.3048;

function metersToMiles(m) { return (m || 0) / M_PER_MILE; }
function metersToFeet(m)  { return (m || 0) / M_PER_FOOT; }

function fmtMiles(m, decimals = 1) {
  return metersToMiles(m).toFixed(decimals);
}

function fmtFeet(m) {
  return Math.round(metersToFeet(m)).toLocaleString();
}

function fmtRunTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// pace stored as sec/km -> "M:SS /mi"
function fmtPace(secPerKm) {
  if (!secPerKm) return '—';
  const secPerMile = secPerKm * 1.60934;
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, '0')} /mi`;
}

const RUN_TYPE_LABELS = {
  recovery:  'Recovery',
  easy:      'Easy',
  tempo:     'Tempo',
  intervals: 'Intervals',
  long:      'Long Run',
};

/* ═══════════════════════════════════════════════════════════════════
   Run tab renderer
═══════════════════════════════════════════════════════════════════ */

class RunTab {
  constructor() {
    this._runs = [];
  }

  update({ runs } = {}) {
    if (runs != null) this._runs = runs;
    this._renderSummary();
    this._renderList();
  }

  _renderSummary() {
    const el = document.getElementById('run-summary');
    if (!el) return;
    if (!this._runs.length) { el.style.display = 'none'; return; }

    const totalDist = this._runs.reduce((s, r) => s + (r.distance_m || 0), 0);
    const totalElev = this._runs.reduce((s, r) => s + (r.elevation_gain_m || 0), 0);
    const totalTime = this._runs.reduce((s, r) => s + (r.elapsed || 0), 0);

    document.getElementById('rs-runs').textContent  = this._runs.length;
    document.getElementById('rs-miles').textContent  = fmtMiles(totalDist, 0);
    document.getElementById('rs-vert').textContent   = fmtFeet(totalElev);
    document.getElementById('rs-time').textContent   = fmtRunTime(totalTime);
    el.style.display = 'flex';
  }

  _renderList() {
    const list  = document.getElementById('run-list');
    const empty = document.getElementById('run-empty');
    const count = document.getElementById('run-count');
    if (!list) return;

    list.innerHTML = '';
    count.textContent = this._runs.length ? `${this._runs.length} run${this._runs.length === 1 ? '' : 's'}` : '';

    if (!this._runs.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    this._runs.forEach(run => {
      const card = document.createElement('div');
      card.className = 'ride-card';

      const date = run.date
        ? new Date(run.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';

      card.innerHTML = `
        <div>
          <div class="ride-card-title">${run.name || 'Run'}</div>
          <div class="ride-card-date">${date}</div>
        </div>
        <span class="ride-card-badge completed">Strava</span>
        <div class="ride-card-stats">
          <div class="ride-stat"><span class="ride-stat-value">${fmtMiles(run.distance_m)}</span><span class="ride-stat-label">Miles</span></div>
          <div class="ride-stat"><span class="ride-stat-value">${fmtFeet(run.elevation_gain_m)}</span><span class="ride-stat-label">Vert (ft)</span></div>
          <div class="ride-stat"><span class="ride-stat-value">${fmtRunTime(run.elapsed)}</span><span class="ride-stat-label">Time</span></div>
          <div class="ride-stat"><span class="ride-stat-value">${fmtPace(run.avg_pace_sec_per_km)}</span><span class="ride-stat-label">Pace</span></div>
        </div>
        <div class="ride-card-actions">
          ${run.strava_id ? `<a class="strava-view" href="https://www.strava.com/activities/${run.strava_id}" target="_blank" rel="noopener">View on Strava ↗</a>` : ''}
          <button class="btn btn-stop" data-delete-run="${run.id}" style="font-size:12px;padding:5px 12px">Delete</button>
        </div>
      `;

      card.querySelector('[data-delete-run]').addEventListener('click', e => {
        const rid = e.currentTarget.dataset.deleteRun;
        if (confirm('Delete this run?')) window.sendWS({ action: 'delete_run', run_id: rid });
      });

      list.appendChild(card);
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Run Plan Generator – modal popup (mirrors PlanGenerator)
═══════════════════════════════════════════════════════════════════ */

class RunPlanGenerator {
  constructor() {
    this._bindPills('rpg-level');
    this._bindPills('rpg-days');
    this._bindGenerate();
    this._bindClear();
  }

  showInsights({ status, message }) {
    const banner = document.getElementById('rpg-insights-banner');
    const dot    = document.getElementById('run-insights-dot');
    const label  = document.getElementById('run-insights-status-label');
    const msg    = document.getElementById('run-insights-message');
    if (!banner) return;

    const labels = {
      on_track:      'On Track',
      adjusted_up:   'Mileage Increased',
      adjusted_down: 'Volume Reduced',
    };

    dot.className     = `pg-insights-dot ${status}`;
    label.textContent = labels[status] || 'Plan Updated';
    msg.textContent   = ' — ' + message;
    banner.style.display = 'flex';
  }

  _open()  { const o = document.getElementById('rpg-overlay'); if (o) { o.style.display = 'flex'; document.body.style.overflow = 'hidden'; } }
  _close() { const o = document.getElementById('rpg-overlay'); if (o) { o.style.display = 'none';  document.body.style.overflow = ''; } }

  _bindPills(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.pg-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.pg-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  _getVal(groupId) {
    return document.getElementById(groupId)
      ?.querySelector('.pg-pill.active')
      ?.dataset.val ?? null;
  }

  _bindGenerate() {
    document.getElementById('rpg-generate-btn')?.addEventListener('click', () => {
      const profile = {
        goal:           document.getElementById('rpg-goal')?.value ?? 'base_mileage',
        level:          this._getVal('rpg-level') ?? 'intermediate',
        days_per_week:  parseInt(this._getVal('rpg-days') ?? '4', 10),
        weekly_miles:   parseFloat(document.getElementById('rpg-miles')?.value || '15'),
        notes:          document.getElementById('rpg-notes')?.value ?? '',
      };

      const btn = document.getElementById('rpg-generate-btn');
      btn.disabled    = true;
      btn.textContent = 'Generating…';

      window.sendWS({ action: 'generate_run_plan', profile });

      setTimeout(() => {
        btn.disabled    = false;
        btn.textContent = 'Generate 6-Week Plan';
        this._close();
      }, 2500);
    });
  }

  _bindClear() {
    document.getElementById('rpg-clear-btn')?.addEventListener('click', () => {
      if (!confirm('Remove all scheduled runs from the calendar?')) return;
      window.sendWS({ action: 'clear_run_plan' });
      const banner = document.getElementById('rpg-insights-banner');
      if (banner) banner.style.display = 'none';
      this._close();
    });
  }
}

window.RunTab           = RunTab;
window.RunPlanGenerator = RunPlanGenerator;
