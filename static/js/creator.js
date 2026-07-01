/**
 * WorkoutCreator – manages the Create tab UI.
 * Calls window.sendWS(msg) to persist, gets workouts list via onWorkoutsUpdated callback.
 */
class WorkoutCreator {
  constructor() {
    this._intervals = [];
    this._chart     = null;

    this._elName   = document.getElementById('c-name');
    this._elDesc   = document.getElementById('c-desc');
    this._elFTP    = document.getElementById('c-ftp');
    this._elDur    = document.getElementById('c-dur');
    this._elPwr    = document.getElementById('c-pwr');
    this._elLbl    = document.getElementById('c-lbl');
    this._elList   = document.getElementById('c-intervals');
    this._elTotal  = document.getElementById('c-total-time');
    this._elPlaceholder = document.getElementById('create-placeholder');

    document.getElementById('c-add-btn').addEventListener('click', () => this._addInterval());
    document.getElementById('c-save-btn').addEventListener('click', () => this._save());
    document.getElementById('c-clear-btn').addEventListener('click', () => this._clear());

    // Duration input: allow "Enter" to jump to power
    this._elDur.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._elPwr.focus();
    });
    this._elPwr.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._elLbl.focus();
    });
    this._elLbl.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this._addInterval(); }
    });

    // Live-preview FTP changes
    this._elFTP.addEventListener('input', () => {
      if (this._chart) this._chart.setFTP(Number(this._elFTP.value) || 250);
    });

    // Init canvas
    const canvas = document.getElementById('create-canvas');
    this._chart = new WorkoutChart(canvas, { ftp: 250 });
  }

  /* ── public ──────────────────────────────────────────────── */

  /** Pre-fill creator from an existing workout object for editing. */
  loadWorkout(w) {
    this._elName.value = w.name        || '';
    this._elDesc.value = w.description || '';
    this._elFTP.value  = 250;

    this._intervals = (w.intervals || []).map(iv => ({
      duration:  iv.duration,
      power_pct: iv.power_pct,
      name:      iv.name || '',
    }));

    this._renderList();
    this._renderChart();
    // Switch to Create tab
    document.querySelector('[data-tab="create"]').click();
  }

  /* ── internals ───────────────────────────────────────────── */

  _parseDuration(str) {
    str = str.trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) return parseInt(str, 10);   // plain seconds
    const m = str.match(/^(\d+):(\d{1,2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return null;
  }

  _fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, '0')}`;
  }

  _addInterval() {
    const dur  = this._parseDuration(this._elDur.value);
    const pct  = parseFloat(this._elPwr.value);
    const name = this._elLbl.value.trim();

    if (!dur || dur <= 0) {
      this._shake(this._elDur);
      return;
    }
    if (!pct || pct <= 0 || pct > 400) {
      this._shake(this._elPwr);
      return;
    }

    this._intervals.push({ duration: dur, power_pct: pct / 100, name });
    this._elDur.value = '';
    this._elPwr.value = '';
    this._elLbl.value = '';
    this._elDur.focus();

    this._renderList();
    this._renderChart();
  }

  _deleteInterval(idx) {
    this._intervals.splice(idx, 1);
    this._renderList();
    this._renderChart();
  }

  _renderList() {
    const list = this._elList;
    list.innerHTML = '';

    const totalSec = this._intervals.reduce((s, iv) => s + iv.duration, 0);
    this._elTotal.textContent = this._fmtDuration(totalSec);

    this._intervals.forEach((iv, i) => {
      const row = document.createElement('div');
      row.className = 'interval-row';

      const zoneName = WorkoutChart.zoneName(iv.power_pct);
      const color    = WorkoutChart.zoneColor(iv.power_pct);
      const label    = iv.name || zoneName;

      row.innerHTML = `
        <span class="interval-row-num">${i + 1}</span>
        <span class="interval-row-name" title="${label}">${label}</span>
        <span class="interval-row-dur">${this._fmtDuration(iv.duration)}</span>
        <span class="interval-row-pwr" style="color:${color}">${Math.round(iv.power_pct * 100)}%</span>
        <button class="interval-row-del" title="Delete">×</button>
      `;

      row.querySelector('.interval-row-del').addEventListener('click', () => this._deleteInterval(i));
      list.appendChild(row);
    });

    // Show/hide placeholder
    const canvas = document.getElementById('create-canvas');
    const ph     = this._elPlaceholder;
    if (this._intervals.length) {
      canvas.style.display  = 'block';
      ph.style.display      = 'none';
    } else {
      canvas.style.display  = 'none';
      ph.style.display      = 'flex';
    }
  }

  _renderChart() {
    if (!this._chart || !this._intervals.length) return;
    const ftp = Number(this._elFTP.value) || 250;
    this._chart.setFTP(ftp);
    this._chart.setIntervals(this._intervals);
  }

  _save() {
    const name = this._elName.value.trim();
    if (!name) { this._shake(this._elName); return; }
    if (!this._intervals.length) { window.toast('Add at least one interval'); return; }

    const workout = {
      name,
      description: this._elDesc.value.trim(),
      intervals:   this._intervals.map(iv => ({
        duration:  iv.duration,
        power_pct: iv.power_pct,
        name:      iv.name,
      })),
    };

    window.sendWS({ action: 'save_workout', workout });
    window.toast(`Saved "${name}"`);
  }

  _clear() {
    this._intervals = [];
    this._elName.value = '';
    this._elDesc.value = '';
    this._elDur.value  = '';
    this._elPwr.value  = '';
    this._elLbl.value  = '';
    this._renderList();
    if (this._chart) this._chart.reset();
  }

  _shake(el) {
    el.style.outline = '2px solid #e83030';
    el.focus();
    setTimeout(() => { el.style.outline = ''; }, 800);
  }
}
