'use strict';

/* ═══════════════════════════════════════════════════════════════════
   WebWorkoutEngine – client-side port of server/workout_engine.py.
   Runs entirely in the browser; talks to BLEWebManager for ERG mode.
═══════════════════════════════════════════════════════════════════ */

class WebWorkoutEngine {
  constructor({ workout, ftp, ble, simulate, onUpdate }) {
    this._workout      = workout;
    this._ftp          = Math.max(ftp, 1);
    this._ble          = ble;
    this._simulate     = simulate;
    this._onUpdate     = onUpdate;

    this._intervals    = workout.intervals || [];
    this._ivIdx        = 0;
    this._ivElapsed    = 0;
    this._elapsed      = 0;
    this._paused       = false;
    this._running      = false;
    this._powerOffset  = 0;

    this._lastPower    = 0;
    this._lastCadence  = null;
    this._powerSamples = [];
    this._timer        = null;
  }

  start() {
    this._running = true;
    this._applyTarget();
    this._timer = setInterval(() => this._tick(), 1000);
    this._broadcast();
  }

  pause()  { this._paused = true;  this._emit({ type: 'paused', paused: true  }); }
  resume() { this._paused = false; this._emit({ type: 'paused', paused: false }); this._applyTarget(); }

  stop() {
    clearInterval(this._timer);
    this._running = false;
    this._saveRide();
  }

  skipInterval() {
    if (this._ivIdx < this._intervals.length - 1) {
      this._ivIdx++;
      this._ivElapsed = 0;
      // Jump the workout clock to the start of the next interval so the
      // chart cursor and remaining time reflect the new position.
      this._elapsed = this._intervals
        .slice(0, this._ivIdx)
        .reduce((s, iv) => s + iv.duration, 0);
      this._applyTarget();
      this._broadcast();
    }
  }

  adjustPower(delta) {
    this._powerOffset += delta;
    this._applyTarget();
    this._emit({ type: 'power_offset', offset: this._powerOffset });
  }

  // Called by the BLE data callback
  recordPower(watts, cadence = null) {
    this._lastPower   = watts;
    this._lastCadence = cadence;
    if (!this._paused) this._powerSamples.push(watts);
  }

  // ── Private ────────────────────────────────────────────────────────

  _tick() {
    if (!this._running || this._paused) return;

    this._elapsed++;
    this._ivElapsed++;

    const iv = this._intervals[this._ivIdx];
    if (this._ivElapsed >= iv.duration) {
      if (this._ivIdx >= this._intervals.length - 1) {
        this.stop(); return;
      }
      this._ivIdx++;
      this._ivElapsed = 0;
      this._applyTarget();
    }

    if (this._simulate) {
      const t = this._targetWatts();
      this._lastPower = Math.max(0, Math.round(t * (0.93 + Math.random() * 0.14) + (Math.random() - 0.5) * 12));
      this._powerSamples.push(this._lastPower);
    }

    this._broadcast();
  }

  _targetWatts() {
    // power_pct is a fraction of FTP (0.65 = 65%)
    const iv = this._intervals[this._ivIdx];
    return Math.round((iv?.power_pct ?? 1) * this._ftp) + this._powerOffset;
  }

  _applyTarget() {
    if (this._ble && !this._simulate) this._ble.setTargetPower(this._targetWatts());
  }

  _broadcast() {
    const total = this._intervals.reduce((s, iv) => s + iv.duration, 0);
    const iv    = this._intervals[this._ivIdx];
    const np    = this._calcNP();
    const ifVal = np / this._ftp;
    const tss   = (this._elapsed / 3600) * ifVal * ifVal * 100;
    const avg   = this._powerSamples.length
      ? this._powerSamples.reduce((a, b) => a + b, 0) / this._powerSamples.length : 0;

    this._emit({
      type:               'live_data',
      power:              this._lastPower,
      target:             this._targetWatts(),
      cadence:            this._lastCadence,
      elapsed:            this._elapsed,
      remaining:          Math.max(0, total - this._elapsed),
      interval_idx:       this._ivIdx,
      interval_name:      iv?.label ?? '',
      interval_elapsed:   this._ivElapsed,
      interval_duration:  iv?.duration ?? 0,
      power_offset:       this._powerOffset,
      avg_power:          Math.round(avg),
      normalized_power:   Math.round(np),
      intensity_factor:   Math.round(ifVal * 100) / 100,
      tss:                Math.round(tss * 10) / 10,
    });
  }

  _saveRide() {
    const total = this._intervals.reduce((s, iv) => s + iv.duration, 0);
    const np    = this._calcNP();
    const ifVal = np / this._ftp;
    const tss   = (this._elapsed / 3600) * ifVal * ifVal * 100;
    const avg   = this._powerSamples.length
      ? this._powerSamples.reduce((a, b) => a + b, 0) / this._powerSamples.length : 0;

    this._emit({
      type: 'save_ride',
      ride: {
        workout_name:     this._workout.name,
        date:             new Date().toISOString().split('T')[0],
        elapsed:          this._elapsed,
        total_duration:   total,
        avg_power:        Math.round(avg),
        normalized_power: Math.round(np),
        intensity_factor: Math.round(ifVal * 100) / 100,
        tss:              Math.round(tss * 10) / 10,
        ftp:              this._ftp,
        completed:        this._elapsed >= total * 0.95,
        power_samples:    this._powerSamples.slice(0, 3600),
      },
    });
  }

  _calcNP() {
    const s = this._powerSamples;
    if (!s.length) return 0;
    if (s.length < 30) return s.reduce((a, b) => a + b, 0) / s.length;

    const windows = [];
    for (let i = 29; i < s.length; i++) {
      const avg = s.slice(i - 29, i + 1).reduce((a, b) => a + b, 0) / 30;
      windows.push(avg ** 4);
    }
    return (windows.reduce((a, b) => a + b, 0) / windows.length) ** 0.25;
  }

  _emit(msg) { if (this._onUpdate) this._onUpdate(msg); }
}
