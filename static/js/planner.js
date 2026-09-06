'use strict';

class CalendarPlanner {
  constructor() {
    const now     = new Date();
    this._year    = now.getFullYear();
    this._month   = now.getMonth();   // 0-based
    this._plan     = {};
    this._workouts = [];
    this._rides    = [];
    this._runPlan   = {};
    this._runs      = [];
    this._swimPlan     = {};
    this._swims        = [];
    this._strengthPlan = {};
    this._strength     = [];
    this._selDate  = null;
    this._dayChart = null;

    this._bindEvents();
    this.render();
  }

  // Called from app.js whenever plan, workout list, or any discipline's
  // activity/plan data changes.
  update({ plan, workouts, rides, runPlan, runs,
           swimPlan, swims, strengthPlan, strength } = {}) {
    if (plan         != null) this._plan         = plan;
    if (workouts     != null) this._workouts     = workouts;
    if (rides        != null) this._rides        = rides;
    if (runPlan      != null) this._runPlan      = runPlan;
    if (runs         != null) this._runs         = runs;
    if (swimPlan     != null) this._swimPlan     = swimPlan;
    if (swims        != null) this._swims        = swims;
    if (strengthPlan != null) this._strengthPlan = strengthPlan;
    if (strength     != null) this._strength     = strength;
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

      // Planned run chip — click for details (read-only; managed from the coach chat)
      const runEntry = this._runPlan[dateStr];
      if (runEntry) {
        const chip = document.createElement('div');
        chip.className   = 'cal-chip cal-chip-run';
        const label = (typeof RUN_TYPE_LABELS !== 'undefined' && RUN_TYPE_LABELS[runEntry.run_type]) || runEntry.run_type;
        const miles = TargetFormat.runDistance(runEntry.target_distance_m, { short: true });
        chip.textContent = `🏃 ${label}${miles ? ` · ${miles}` : ''}`;
        chip.addEventListener('click', e => {
          e.stopPropagation();
          this._openEntryModal('run', dateStr, runEntry);
        });
        cell.appendChild(chip);
      }

      // Planned swim chip — click for details (read-only — managed from the coach chat)
      const swimEntry = this._swimPlan[dateStr];
      if (swimEntry) {
        const chip = document.createElement('div');
        chip.className = 'cal-chip cal-chip-swim';
        const label = (typeof SWIM_TYPE_LABELS !== 'undefined' && SWIM_TYPE_LABELS[swimEntry.swim_type]) || swimEntry.swim_type;
        const dist = TargetFormat.swimDistance(swimEntry.target_distance_m, { short: true });
        chip.textContent = `🏊 ${label}${dist ? ` · ${dist}` : ''}`;
        chip.addEventListener('click', e => {
          e.stopPropagation();
          this._openEntryModal('swim', dateStr, swimEntry);
        });
        cell.appendChild(chip);
      }

      // Planned strength chip — click for details
      const strengthEntry = this._strengthPlan[dateStr];
      if (strengthEntry) {
        const chip = document.createElement('div');
        chip.className = 'cal-chip cal-chip-strength';
        const label = (typeof STRENGTH_FOCUS_LABELS !== 'undefined' && STRENGTH_FOCUS_LABELS[strengthEntry.focus]) || strengthEntry.focus;
        const mins = TargetFormat.duration(strengthEntry.target_duration_min, { short: true });
        chip.textContent = `🏋 ${label}${mins ? ` · ${mins}` : ''}`;
        chip.addEventListener('click', e => {
          e.stopPropagation();
          this._openEntryModal('strength', dateStr, strengthEntry);
        });
        cell.appendChild(chip);
      }

      // Completed activity dots
      const ridesDone    = this._rides.filter(r => r.date && r.date.startsWith(dateStr));
      const runsDone     = this._runs.filter(r => r.date && r.date.startsWith(dateStr));
      const swimsDone    = this._swims.filter(s => s.date && s.date.startsWith(dateStr));
      const strengthDone = this._strength.filter(s => s.date && s.date.startsWith(dateStr));
      if (ridesDone.length || runsDone.length || swimsDone.length || strengthDone.length) {
        const dots = document.createElement('div');
        dots.className = 'cal-dots';
        ridesDone.slice(0, 3).forEach(r => {
          const dot = document.createElement('span');
          dot.className = 'cal-dot ' + (r.source === 'strava'
            ? 'strava'
            : (r.completed ? 'done' : 'partial'));
          dot.title = (r.source === 'strava' ? 'Strava: ' : '') + (r.workout_name || 'Ride');
          dots.appendChild(dot);
        });
        runsDone.slice(0, 2).forEach(r => {
          const dot = document.createElement('span');
          dot.className = 'cal-dot run';
          dot.title = `Run: ${r.name || 'Run'}`;
          dots.appendChild(dot);
        });
        swimsDone.slice(0, 2).forEach(s => {
          const dot = document.createElement('span');
          dot.className = 'cal-dot swim';
          dot.title = `Swim: ${s.name || 'Swim'}`;
          dots.appendChild(dot);
        });
        strengthDone.slice(0, 2).forEach(s => {
          const dot = document.createElement('span');
          dot.className = 'cal-dot strength';
          dot.title = `Strength: ${s.name || 'Strength session'}`;
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
    this._updateDayDetails();
  }

  // Renders the interval chart + summary line for whatever workout is
  // currently selected in the day-modal — the assigned workout on open,
  // or whatever the user is browsing to in the dropdown.
  _updateDayDetails() {
    const wid    = document.getElementById('day-workout-select').value;
    const w      = this._workouts.find(x => x.id === wid);
    const canvas = document.getElementById('day-workout-canvas');
    const ph     = document.getElementById('day-chart-placeholder');
    const meta   = document.getElementById('day-workout-meta');
    if (!canvas) return;

    if (!w) {
      canvas.style.display = 'none';
      if (ph)   ph.style.display = 'flex';
      if (meta) meta.textContent = '';
      return;
    }

    const ftpEl = document.getElementById('ftp-input');
    const ftp   = (ftpEl && parseInt(ftpEl.value, 10)) || 250;

    if (!this._dayChart) this._dayChart = new WorkoutChart(canvas, { ftp });
    this._dayChart.setFTP(ftp);
    this._dayChart.setIntervals(w.intervals);

    canvas.style.display = 'block';
    if (ph)   ph.style.display = 'none';
    if (meta) meta.textContent = `${w.intervals.length} intervals  ·  ${fmtTime(w.total_duration)}`;
  }

  _closeModal() {
    document.getElementById('day-modal').style.display = 'none';
    this._selDate = null;
  }

  // Public dispatcher — lets other views (e.g. the Dashboard's "Upcoming"
  // list) open the right detail popup for a scheduled item without
  // knowing which modal each discipline uses.
  openWorkoutDetail(disciplineKey, dateStr, entry) {
    if (disciplineKey === 'bike') { this._openModal(dateStr); return; }
    this._openEntryModal(disciplineKey, dateStr, entry);
  }

  // Read-only detail popup for run/swim/strength calendar entries — these
  // have no per-day editor (unlike cycling's day-modal), just a summary.
  _openEntryModal(kind, dateStr, entry) {
    const modal = document.getElementById('entry-detail-modal');
    const title = document.getElementById('entry-detail-title');
    const body  = document.getElementById('entry-detail-body');
    if (!modal || !title || !body || !entry) return;

    const d = new Date(dateStr + 'T12:00:00');
    const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    let icon = '', rows = [];
    if (kind === 'run') {
      icon = '🏃';
      const label = (typeof RUN_TYPE_LABELS !== 'undefined' && RUN_TYPE_LABELS[entry.run_type]) || entry.run_type;
      rows = [
        ['Type', label],
        entry.target_distance_m   && ['Distance', TargetFormat.runDistance(entry.target_distance_m)],
        entry.target_duration_min && ['Duration', TargetFormat.duration(entry.target_duration_min)],
        entry.description         && ['Notes', entry.description],
      ];
    } else if (kind === 'swim') {
      icon = '🏊';
      const label = (typeof SWIM_TYPE_LABELS !== 'undefined' && SWIM_TYPE_LABELS[entry.swim_type]) || entry.swim_type;
      const dist = TargetFormat.swimDistance(entry.target_distance_m);
      rows = [
        ['Type', label],
        dist                      && ['Distance', dist],
        entry.target_duration_min && ['Duration', TargetFormat.duration(entry.target_duration_min)],
        entry.description         && ['Notes', entry.description],
      ];
    } else if (kind === 'strength') {
      icon = '🏋';
      const label = (typeof STRENGTH_FOCUS_LABELS !== 'undefined' && STRENGTH_FOCUS_LABELS[entry.focus]) || entry.focus;
      rows = [
        ['Focus', label],
        entry.target_duration_min && ['Duration', TargetFormat.duration(entry.target_duration_min)],
        entry.description         && ['Notes', entry.description],
      ];
    }

    title.textContent = `${icon} ${dateLabel}`;
    body.innerHTML = '';
    rows.filter(Boolean).forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'entry-detail-row';
      const l = document.createElement('span');
      l.className = 'entry-detail-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'entry-detail-value';
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      body.appendChild(row);
    });

    modal.style.display = 'flex';
  }

  _closeEntryModal() {
    const modal = document.getElementById('entry-detail-modal');
    if (modal) modal.style.display = 'none';
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

    document.getElementById('cal-clear-btn')?.addEventListener('click', () => {
      if (confirm('Clear your generated calendar? This removes all scheduled workouts and runs.')) {
        window.sendWS({ action: 'clear_calendar' });
      }
    });

    document.getElementById('day-save-btn').addEventListener('click',   () => this._save());
    document.getElementById('day-cancel-btn').addEventListener('click', () => this._closeModal());
    document.getElementById('day-ride-btn').addEventListener('click',   () => this._rideNow());

    // Show/hide "Ride Now" and refresh the details chart as the user
    // browses workout options in the modal.
    document.getElementById('day-workout-select').addEventListener('change', () => {
      if (!this._selDate) return;
      const todayStr = _isoDate(new Date());
      const wid      = document.getElementById('day-workout-select').value;
      document.getElementById('day-ride-btn').style.display =
        this._selDate >= todayStr && wid ? 'inline-flex' : 'none';
      this._updateDayDetails();
    });

    // Dismiss modal on backdrop click
    document.getElementById('day-modal').addEventListener('click', e => {
      if (e.target.id === 'day-modal') this._closeModal();
    });

    document.getElementById('entry-detail-close')?.addEventListener('click', () => this._closeEntryModal());
    document.getElementById('entry-detail-modal')?.addEventListener('click', e => {
      if (e.target.id === 'entry-detail-modal') this._closeEntryModal();
    });
  }
}

function _isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
