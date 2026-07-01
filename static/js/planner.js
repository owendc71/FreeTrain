'use strict';

class CalendarPlanner {
  constructor() {
    const now     = new Date();
    this._year    = now.getFullYear();
    this._month   = now.getMonth();   // 0-based
    this._plan     = {};
    this._workouts = [];
    this._rides    = [];
    this._selDate  = null;

    this._bindEvents();
    this.render();
  }

  // Called from app.js whenever plan, workout list, or ride history changes.
  update({ plan, workouts, rides } = {}) {
    if (plan     != null) this._plan     = plan;
    if (workouts != null) this._workouts = workouts;
    if (rides    != null) this._rides    = rides;
    this.render();
    this._refreshTodayBanner();
  }

  render() {
    const label = document.getElementById('cal-month-label');
    const grid  = document.getElementById('calendar-grid');
    if (!grid) return;

    const first = new Date(this._year, this._month, 1);
    label.textContent = first.toLocaleDateString('en-US',
      { month: 'long', year: 'numeric' });

    grid.innerHTML = '';

    const todayStr    = _isoDate(new Date());
    const firstDow    = first.getDay();
    const daysInMonth = new Date(this._year, this._month + 1, 0).getDate();

    // Leading blank cells
    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement('div');
      blank.className = 'cal-cell cal-blank';
      grid.appendChild(blank);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${this._year}-${String(this._month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = dateStr === todayStr;
      const isPast  = dateStr < todayStr;

      const cell = document.createElement('div');
      cell.className = 'cal-cell'
        + (isToday ? ' cal-today' : '')
        + (isPast  ? ' cal-past'  : '');
      cell.dataset.date = dateStr;

      const num = document.createElement('div');
      num.className   = 'cal-day-num';
      num.textContent = day;
      cell.appendChild(num);

      // Planned workout chip
      const wid = this._plan[dateStr];
      if (wid) {
        const w    = this._workouts.find(x => x.id === wid);
        const chip = document.createElement('div');
        chip.className   = 'cal-chip';
        chip.textContent = w ? w.name : '(deleted)';
        cell.appendChild(chip);
      }

      // Completed ride dots
      const ridesDone = this._rides.filter(r => r.date && r.date.startsWith(dateStr));
      if (ridesDone.length) {
        const dots = document.createElement('div');
        dots.className = 'cal-dots';
        ridesDone.slice(0, 4).forEach(r => {
          const dot = document.createElement('span');
          dot.className = 'cal-dot ' + (r.completed ? 'done' : 'partial');
          dot.title     = r.workout_name || 'Ride';
          dots.appendChild(dot);
        });
        cell.appendChild(dots);
      }

      cell.addEventListener('click', () => this._openModal(dateStr));
      grid.appendChild(cell);
    }
  }

  _refreshTodayBanner() {
    const todayStr = _isoDate(new Date());
    const wid      = this._plan[todayStr];
    const banner   = document.getElementById('today-plan');
    if (!banner) return;

    if (wid) {
      const w = this._workouts.find(x => x.id === wid);
      if (w) {
        document.getElementById('today-plan-name').textContent =
          `${w.name}  ·  ${fmtTime(w.total_duration)}`;
        banner.dataset.workoutId = wid;
        banner.style.display = 'flex';
        return;
      }
    }
    banner.style.display = 'none';
    delete banner.dataset.workoutId;
  }

  _openModal(dateStr) {
    this._selDate = dateStr;
    const modal   = document.getElementById('day-modal');
    const title   = document.getElementById('day-modal-title');
    const sel     = document.getElementById('day-workout-select');
    const rideBtn = document.getElementById('day-ride-btn');

    const d = new Date(dateStr + 'T12:00:00');
    title.textContent = d.toLocaleDateString('en-US',
      { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    sel.innerHTML = '<option value="">— Rest Day —</option>';
    this._workouts.forEach(w => {
      const opt       = document.createElement('option');
      opt.value       = w.id;
      opt.textContent = `${w.name}  (${fmtTime(w.total_duration)})`;
      if (this._plan[dateStr] === w.id) opt.selected = true;
      sel.appendChild(opt);
    });

    const todayStr = _isoDate(new Date());
    const showRide = dateStr >= todayStr && !!this._plan[dateStr];
    rideBtn.style.display = showRide ? 'inline-flex' : 'none';

    modal.style.display = 'flex';
  }

  _closeModal() {
    document.getElementById('day-modal').style.display = 'none';
    this._selDate = null;
  }

  _save() {
    const wid = document.getElementById('day-workout-select').value || null;
    window.sendWS({ action: 'plan_day', date: this._selDate, workout_id: wid });
    this._closeModal();
  }

  _rideNow() {
    const wid = document.getElementById('day-workout-select').value;
    this._closeModal();
    if (wid && window.switchToWorkout) window.switchToWorkout(wid);
  }

  _bindEvents() {
    document.getElementById('cal-prev').addEventListener('click', () => {
      this._month--;
      if (this._month < 0) { this._month = 11; this._year--; }
      this.render();
    });

    document.getElementById('cal-next').addEventListener('click', () => {
      this._month++;
      if (this._month > 11) { this._month = 0; this._year++; }
      this.render();
    });

    document.getElementById('cal-today-btn').addEventListener('click', () => {
      const now   = new Date();
      this._year  = now.getFullYear();
      this._month = now.getMonth();
      this.render();
    });

    document.getElementById('day-save-btn').addEventListener('click',   () => this._save());
    document.getElementById('day-cancel-btn').addEventListener('click', () => this._closeModal());
    document.getElementById('day-ride-btn').addEventListener('click',   () => this._rideNow());

    // Show/hide "Ride Now" as user changes workout selection in the modal
    document.getElementById('day-workout-select').addEventListener('change', () => {
      if (!this._selDate) return;
      const todayStr = _isoDate(new Date());
      const wid      = document.getElementById('day-workout-select').value;
      document.getElementById('day-ride-btn').style.display =
        this._selDate >= todayStr && wid ? 'inline-flex' : 'none';
    });

    // Dismiss modal on backdrop click
    document.getElementById('day-modal').addEventListener('click', e => {
      if (e.target.id === 'day-modal') this._closeModal();
    });
  }
}

function _isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════════════
   Plan Generator – modal popup
═══════════════════════════════════════════════════════════════════ */

class PlanGenerator {
  constructor() {
    // Note: open button is also wired in app.js DOMContentLoaded for resilience.
    this._bindCloseButtons();
    this._bindPills('pg-level');
    this._bindPills('pg-days');
    this._bindPills('pg-hours');
    this._bindGenerate();
    this._bindClear();
    this._updateSessionHint();
  }

  // ── Public: called from app.js on adaptation_feedback ────────────
  showInsights({ status, message }) {
    const banner = document.getElementById('pg-insights-banner');
    const dot    = document.getElementById('insights-dot');
    const label  = document.getElementById('insights-status-label');
    const msg    = document.getElementById('insights-message');
    if (!banner) return;

    const labels = {
      on_track:     'On Track',
      adjusted_up:  'Intensity Increased',
      adjusted_down:'Load Reduced',
    };

    dot.className     = `pg-insights-dot ${status}`;
    label.textContent = labels[status] || 'Plan Updated';
    msg.textContent   = ' — ' + message;
    banner.style.display = 'flex';
  }

  // ── Open / close (delegates to globals wired in app.js) ──────────
  _open()  { if (window._pgOpen)  window._pgOpen(); }
  _close() { if (window._pgClose) window._pgClose(); }

  _bindCloseButtons() {
    // Handled in app.js; this is a no-op kept for clarity.
  }

  // ── Pill selectors ────────────────────────────────────────────────
  _bindPills(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.pg-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.pg-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._updateSessionHint();
      });
    });
  }

  _getVal(groupId) {
    return document.getElementById(groupId)
      ?.querySelector('.pg-pill.active')
      ?.dataset.val ?? null;
  }

  _updateSessionHint() {
    const days = parseInt(this._getVal('pg-days') ?? '4', 10);
    const hrs  = parseInt(this._getVal('pg-hours') ?? '5', 10);
    const mins = Math.round((hrs * 60) / days);
    const hint = document.getElementById('pg-session-hint');
    if (hint) hint.textContent = `≈ ${mins} min per session`;
  }

  // ── Generate ──────────────────────────────────────────────────────
  _bindGenerate() {
    document.getElementById('pg-generate-btn')
      ?.addEventListener('click', () => {
        const days = parseInt(this._getVal('pg-days') ?? '4', 10);
        const hrs  = parseInt(this._getVal('pg-hours') ?? '5', 10);

        const profile = {
          goal:          document.getElementById('pg-goal')?.value ?? 'base_fitness',
          level:         this._getVal('pg-level') ?? 'intermediate',
          days_per_week: days,
          session_mins:  Math.round((hrs * 60) / days),
          notes:         document.getElementById('pg-notes')?.value ?? '',
        };

        const btn = document.getElementById('pg-generate-btn');
        btn.disabled    = true;
        btn.textContent = 'Generating…';

        window.sendWS({ action: 'generate_plan', profile });

        setTimeout(() => {
          btn.disabled    = false;
          btn.textContent = 'Generate 6-Week Plan';
          this._close();
        }, 2500);
      });
  }

  // ── Clear ─────────────────────────────────────────────────────────
  _bindClear() {
    document.getElementById('pg-clear-btn')
      ?.addEventListener('click', () => {
        if (!confirm('Remove all FreeTrain-generated workouts from the calendar?')) return;
        window.sendWS({ action: 'clear_plan' });
        const banner = document.getElementById('pg-insights-banner');
        if (banner) banner.style.display = 'none';
        this._close();
      });
  }
}

window.PlanGenerator = PlanGenerator;
