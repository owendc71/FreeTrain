'use strict';

/* ═══════════════════════════════════════════════════════════════════
   FreeTrain Web – main app controller
   No WebSocket — all data goes directly to Supabase.
   BLE handled by BLEWebManager. Workout engine: WebWorkoutEngine.
═══════════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────────
const state = {
  workouts:         [],
  selected:         null,
  ftp:              250,
  running:          false,
  paused:           false,
  trainerConn:      false,
  totalDuration:    0,
  targetPower:      0,
  powerOffset:      0,
  currentPower:     null,
  cadence:          null,
  heartRate:        null,
};

let _sb     = null;
let _userId = null;
let _ble    = null;
let _engine = null;
let _rides  = [];
let _plan   = {};

// sendWS is the universal message bus — routes to _handleAction in web mode
window.sendWS = msg => _handleAction(msg);

// ── Startup ───────────────────────────────────────────────────────
window.startApp = async function(token) {
  const { createClient } = window.supabase;
  _sb = createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey);

  // Session is already in localStorage from auth.js sign-in; getUser() confirms it.
  const { data: { user } } = await _sb.auth.getUser();
  if (!user) { location.reload(); return; }
  _userId = user.id;

  _ble = new BLEWebManager();
  if (!BLEWebManager.isSupported()) {
    const banner = document.getElementById('ble-unsupported-banner');
    if (banner) banner.style.display = 'block';
    const hint = document.getElementById('ble-hint');
    if (hint) hint.style.display = 'none';
  }

  await _loadInitialData();
};

async function _loadInitialData() {
  const [workouts, rides, plan] = await Promise.all([
    _fetchWorkouts(), _fetchRides(), _fetchPlan(),
  ]);
  _rides = rides;
  _plan  = plan;

  updateWorkoutList(workouts);
  renderHistory(rides);
  if (window._planner) window._planner.update({ plan, workouts, rides });

  // Show today's plan banner on ride tab
  const today = new Date().toISOString().split('T')[0];
  const todayWid = plan[today];
  if (todayWid) {
    const w = workouts.find(x => x.id === todayWid);
    const el = document.getElementById('today-plan');
    if (w && el) {
      document.getElementById('today-plan-name').textContent = w.name;
      el.dataset.workoutId = todayWid;
      el.style.display = 'flex';
    }
  }
}

// ── Supabase data fetchers ────────────────────────────────────────
async function _fetchWorkouts() {
  const { data } = await _sb.from('workouts').select('*')
    .eq('user_id', _userId).order('created_at');
  return (data || []).map(w => ({
    ...w,
    intervals:      w.intervals      || [],
    total_duration: w.total_duration || 0,
  }));
}

async function _fetchRides() {
  const { data } = await _sb.from('rides').select('*')
    .eq('user_id', _userId).order('created_at', { ascending: false });
  return data || [];
}

async function _fetchPlan() {
  const { data } = await _sb.from('plans')
    .select('date, workout_id')
    .eq('user_id', _userId);
  const out = {};
  (data || []).forEach(p => { if (p.workout_id) out[p.date] = p.workout_id; });
  return out;
}

// ── Action router (replaces WebSocket message types) ─────────────
async function _handleAction(msg) {
  switch (msg.action) {

    // ── Workout lifecycle ──────────────────────────────────────────
    case 'start_workout': {
      const w = state.workouts.find(w => w.id === msg.workout_id);
      if (!w) { toast('Workout not found'); return; }
      state.ftp = msg.ftp || 250;
      _startWorkout(w, state.ftp, msg.simulate);
      break;
    }
    case 'pause':  if (_engine) _engine.pause();  break;
    case 'resume': if (_engine) _engine.resume(); break;
    case 'stop':   if (_engine) _engine.stop();   break;
    case 'skip_interval': if (_engine) _engine.skipInterval();            break;
    case 'adjust_power':  if (_engine) _engine.adjustPower(msg.offset||0); break;

    // ── BLE ────────────────────────────────────────────────────────
    case 'ble_connect':    await _bleConnect();    break;
    case 'ble_disconnect':
      if (_ble) await _ble.disconnect();
      updateDeviceStatus({ trainer_connected: false });
      break;

    // ── Data / history ─────────────────────────────────────────────
    case 'get_history':
      renderHistory(_rides);
      break;

    case 'delete_ride': {
      await _sb.from('rides').delete().eq('id', msg.ride_id).eq('user_id', _userId);
      _rides = _rides.filter(r => r.id !== msg.ride_id);
      renderHistory(_rides);
      if (window._planner) window._planner.update({ rides: _rides });
      break;
    }

    // ── Workouts CRUD ──────────────────────────────────────────────
    case 'save_workout': {
      const w = msg.workout;
      const total = (w.intervals || []).reduce((s, iv) => s + (iv.duration || 0), 0);
      await _sb.from('workouts').insert({
        user_id:        _userId,
        name:           w.name,
        description:    w.description || '',
        intervals:      w.intervals,
        total_duration: total,
      });
      const workouts = await _fetchWorkouts();
      updateWorkoutList(workouts);
      if (window._planner) window._planner.update({ workouts });
      toast('Workout saved!');
      break;
    }

    case 'delete_workout': {
      await _sb.from('workouts').delete().eq('id', msg.workout_id).eq('user_id', _userId);
      const workouts = await _fetchWorkouts();
      updateWorkoutList(workouts);
      if (window._planner) window._planner.update({ workouts });
      break;
    }

    // ── Calendar plan entry (workout_id null = rest day / clear) ──
    case 'plan_day': {
      if (msg.workout_id) {
        await _sb.from('plans').upsert({
          user_id:    _userId,
          date:       msg.date,
          workout_id: msg.workout_id,
        }, { onConflict: 'user_id,date' });
      } else {
        await _sb.from('plans').delete()
          .eq('user_id', _userId).eq('date', msg.date);
      }
      _plan = await _fetchPlan();
      if (window._planner) window._planner.update({ plan: _plan });
      break;
    }

    // ── Generated plan ─────────────────────────────────────────────
    case 'generate_plan':
      await _generatePlan(msg.profile);
      if (msg.profile.ftp) {
        state.ftp = msg.profile.ftp;
        const ftpInput = document.getElementById('ftp-input');
        if (ftpInput) ftpInput.value = msg.profile.ftp;
      }
      break;

    case 'clear_plan':
      await _clearGeneratedPlan();
      break;
  }
}

// ── BLE ───────────────────────────────────────────────────────────
async function _bleConnect() {
  if (!BLEWebManager.isSupported()) {
    toast('Web Bluetooth requires Chrome or Edge on desktop.');
    return;
  }
  const info = await _ble.requestDevice();
  if (!info) return;  // user cancelled picker

  setScanStatus(`Connecting to ${info.name}…`, true);

  const ok = await _ble.connect(msg => {
    if (msg.type === 'live_data') {
      if (msg.power != null && _engine) _engine.recordPower(msg.power, msg.cadence);
      updateLiveData(msg);
    } else if (msg.type === 'device_status') {
      updateDeviceStatus(msg);
      setScanStatus('', false);
    }
  });

  setScanStatus('', false);
  if (ok) {
    toast(`${info.name} connected`);
  } else {
    toast('Connection failed. Is another app using the trainer?');
  }
}

// ── Workout engine ────────────────────────────────────────────────
function _startWorkout(workout, ftp, simulate) {
  if (_engine) { _engine.stop(); _engine = null; }
  state.selected      = workout;
  state.running       = true;
  state.paused        = false;
  state.totalDuration = workout.intervals.reduce((s, iv) => s + iv.duration, 0);

  _engine = new WebWorkoutEngine({
    workout,
    ftp,
    ble:      _ble,
    simulate: !!simulate,
    onUpdate: msg => {
      switch (msg.type) {
        case 'live_data':  _onLive(msg);            break;
        case 'paused':     _onPausedState(msg);     break;
        case 'save_ride':  _onSaveRide(msg.ride);   break;
      }
    },
  });

  setControlsEnabled(true);
  document.getElementById('interval-fill').style.width = '0%';
  _engine.start();
}

function _onLive(msg) {
  state.currentPower  = msg.power;
  state.cadence       = msg.cadence;
  state.targetPower   = msg.target;
  state.powerOffset   = msg.power_offset;

  setMetric('m-power',   msg.power);
  setMetric('m-target',  msg.target);
  setMetric('m-cadence', msg.cadence != null ? Math.round(msg.cadence) : null);
  setMetric('m-elapsed',   fmtTime(msg.elapsed));
  setMetric('m-remaining', fmtTime(msg.remaining));

  // Interval info
  const pct       = state.ftp ? Math.round((msg.target / state.ftp) * 100) : 0;
  const ivTotal   = state.selected?.intervals?.length ?? '?';
  const ivBadge   = `${msg.interval_idx + 1}/${ivTotal}  ${WorkoutChart.zoneName(pct)}`;
  const ivCountEl = document.getElementById('interval-countdown');
  const ivRemain  = Math.max(0, msg.interval_duration - msg.interval_elapsed);

  document.getElementById('interval-name').textContent  = msg.interval_name;
  document.getElementById('interval-badge').textContent = ivBadge;
  if (ivCountEl) ivCountEl.textContent = fmtTime(ivRemain);

  const pctDone = msg.interval_duration
    ? Math.min(100, (msg.interval_elapsed / msg.interval_duration) * 100) : 0;
  const fill = document.getElementById('interval-fill');
  if (fill) fill.style.width = pctDone + '%';

  const adjLabel = document.getElementById('adj-label');
  if (adjLabel) {
    const adj = msg.power_offset;
    adjLabel.textContent = adj === 0 ? '±0W' : (adj > 0 ? `+${adj}W` : `${adj}W`);
  }

  if (window._rideChart) window._rideChart.tick(msg.elapsed, msg.power);
}

function _onPausedState(msg) {
  state.paused = msg.paused;
  const pauseBtn = document.getElementById('pause-btn');
  if (pauseBtn) pauseBtn.textContent = msg.paused ? '▶ Resume' : '⏸ Pause';
}

async function _onSaveRide(ride) {
  _engine = null;
  state.running = false;
  state.paused  = false;

  const { data } = await _sb.from('rides').insert({ user_id: _userId, ...ride }).select().single();
  if (data) _rides.unshift(data);

  toast(`Workout complete! ${fmtTime(ride.elapsed)} · ${ride.workout_name}`);
  resetRideUI();
  renderHistory(_rides);

  // Adaptive plan feedback
  const generated = _rides.filter(r => (r.workout_name || '').startsWith('FreeTrain · '));
  if (generated.length && window._planGen) {
    window._planGen.showInsights(PlanWebEngine.computeAdaptation(generated));
  }

  if (window._planner) window._planner.update({ rides: _rides });
}

// ── Plan generation ───────────────────────────────────────────────
async function _generatePlan(profile) {
  const sessions = PlanWebEngine.generatePlan({
    goal:        profile.goal,
    level:       profile.level,
    daysPerWeek: profile.days_per_week,
    sessionMins: profile.session_mins,
  });

  await _clearGeneratedPlan(true);

  let count = 0;
  for (const { date, workout } of sessions) {
    const total = workout.intervals.reduce((s, iv) => s + iv.duration, 0);
    const { data: w } = await _sb.from('workouts').insert({
      user_id:        _userId,
      name:           workout.name,
      description:    workout.description || '',
      intervals:      workout.intervals,
      total_duration: total,
    }).select().single();
    if (!w) continue;

    await _sb.from('plans').upsert({
      user_id:    _userId,
      date:       date,
      workout_id: w.id,
    }, { onConflict: 'user_id,date' });
    count++;
  }

  const workouts = await _fetchWorkouts();
  _plan = await _fetchPlan();
  updateWorkoutList(workouts);
  if (window._planner) window._planner.update({ plan: _plan, workouts });
  if (window._pgClose) window._pgClose();
  toast(`6-week plan created — ${count} sessions scheduled.`);
}

async function _clearGeneratedPlan(silent = false) {
  const { data: wks } = await _sb.from('workouts')
    .select('id').eq('user_id', _userId).like('name', 'FreeTrain · %');
  if (wks && wks.length) {
    const ids = wks.map(w => w.id);
    await _sb.from('plans').delete().in('workout_id', ids);
    await _sb.from('workouts').delete().in('id', ids);
  }
  if (!silent) {
    const workouts = await _fetchWorkouts();
    _plan = await _fetchPlan();
    updateWorkoutList(workouts);
    if (window._planner) window._planner.update({ plan: _plan, workouts });
    toast('Generated plan cleared.');
  }
}

// ── Workout list ──────────────────────────────────────────────────
function updateWorkoutList(workouts) {
  state.workouts = workouts;
  const sel = document.getElementById('workout-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select a workout —</option>';
  workouts.forEach(w => {
    const opt = document.createElement('option');
    opt.value       = w.id;
    opt.textContent = `${w.name}  (${fmtTime(w.total_duration)})`;
    sel.appendChild(opt);
  });
  if (cur && workouts.find(w => w.id === cur)) sel.value = cur;
  if (state.selected && workouts.find(w => w.id === state.selected.id)) {
    previewWorkout(state.selected.id);
  }
}

function previewWorkout(id) {
  const w = state.workouts.find(w => w.id === id);
  if (!w) { state.selected = null; return; }
  state.selected = w;
  const canvas = document.getElementById('workout-canvas');
  const ph     = document.getElementById('chart-placeholder');
  if (!window._rideChart) {
    window._rideChart = new WorkoutChart(canvas, { ftp: state.ftp });
  }
  window._rideChart.setFTP(state.ftp);
  window._rideChart.setIntervals(w.intervals);
  canvas.style.display = 'block';
  ph.style.display     = 'none';
  document.getElementById('start-btn').disabled = state.running;
  document.getElementById('interval-name').textContent =
    `${w.intervals.length} intervals  ·  ${fmtTime(w.total_duration)}`;
}

// ── Device status ─────────────────────────────────────────────────
function updateDeviceStatus(msg) {
  state.trainerConn = msg.trainer_connected || false;
  const dot   = document.getElementById('trainer-dot');
  const label = document.getElementById('trainer-label');
  if (state.trainerConn) {
    dot.className     = 'status-dot connected';
    label.textContent = msg.trainer || 'Trainer';
  } else {
    dot.className     = 'status-dot disconnected';
    label.textContent = 'No Trainer';
  }
  const dn = document.getElementById('dc-trainer-name');
  const db = document.getElementById('dc-trainer-badge');
  if (state.trainerConn) {
    dn.textContent = msg.trainer || 'Smart Trainer';
    db.textContent = 'Connected';
    db.className   = 'device-badge connected';
  } else {
    dn.textContent = 'No Trainer';
    db.textContent = '—';
    db.className   = 'device-badge disconnected';
  }
  const discBtn = document.getElementById('disconnect-btn');
  if (discBtn) discBtn.style.display = state.trainerConn ? 'block' : 'none';
}

function updateLiveData(msg) {
  if (msg.power   != null) state.currentPower = msg.power;
  if (msg.cadence != null) state.cadence      = msg.cadence;
  if (!state.running) {
    setMetric('m-power',   state.currentPower, '');
    setMetric('m-cadence', state.cadence != null ? Math.round(state.cadence) : null, '');
  }
}

// ── History ───────────────────────────────────────────────────────
function renderHistorySummary(rides) {
  const el = document.getElementById('history-summary');
  if (!el) return;
  if (!rides.length) { el.style.display = 'none'; return; }

  const totalSec  = rides.reduce((s, r) => s + (r.elapsed || 0), 0);
  const totalTss  = rides.reduce((s, r) => s + (r.tss || 0), 0);
  const completed = rides.filter(r => r.completed).length;
  const hrs       = Math.floor(totalSec / 3600);
  const mins      = Math.round((totalSec % 3600) / 60);

  document.getElementById('hs-rides').textContent      = rides.length;
  document.getElementById('hs-time').textContent       = hrs ? `${hrs}h ${mins}m` : `${mins}m`;
  document.getElementById('hs-tss').textContent        = Math.round(totalTss);
  document.getElementById('hs-completion').textContent =
    Math.round((completed / rides.length) * 100) + '%';
  el.style.display = 'flex';
}

function renderHistory(rides) {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const count = document.getElementById('history-count');
  list.innerHTML = '';
  count.textContent = rides.length ? `${rides.length} ride${rides.length === 1 ? '' : 's'}` : '';
  renderHistorySummary(rides);
  if (!rides.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  rides.forEach(ride => {
    const card  = document.createElement('div');
    card.className = 'ride-card';
    const date  = ride.date
      ? new Date(ride.date).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })
      : '—';
    const avgP  = ride.avg_power        ? Math.round(ride.avg_power)        : '—';
    const np    = ride.normalized_power ? Math.round(ride.normalized_power) : '—';
    const ifV   = ride.intensity_factor ? ride.intensity_factor.toFixed(2)  : '—';
    const tss   = ride.tss              ? Math.round(ride.tss)              : '—';
    const badge = ride.completed ? 'completed' : 'incomplete';
    const label = ride.completed ? 'Completed'  : 'Partial';

    card.innerHTML = `
      <div>
        <div class="ride-card-title">${ride.workout_name || 'Workout'}</div>
        <div class="ride-card-date">${date} · FTP ${ride.ftp ?? '—'}W</div>
      </div>
      <span class="ride-card-badge ${badge}">${label}</span>
      <div class="ride-card-stats">
        <div class="ride-stat"><span class="ride-stat-value">${fmtTime(ride.elapsed)}</span><span class="ride-stat-label">Duration</span></div>
        <div class="ride-stat"><span class="ride-stat-value">${avgP}W</span><span class="ride-stat-label">Avg Power</span></div>
        <div class="ride-stat"><span class="ride-stat-value">${np}W</span><span class="ride-stat-label">Norm Power</span></div>
        <div class="ride-stat"><span class="ride-stat-value">${ifV}</span><span class="ride-stat-label">IF</span></div>
        <div class="ride-stat"><span class="ride-stat-value">${tss}</span><span class="ride-stat-label">TSS</span></div>
      </div>
      <div class="ride-card-actions">
        <button class="btn btn-stop" data-delete="${ride.id}" style="font-size:12px;padding:5px 12px">Delete</button>
      </div>
    `;
    card.querySelector('[data-delete]').addEventListener('click', e => {
      const rid = e.currentTarget.dataset.delete;
      if (confirm('Delete this ride?')) window.sendWS({ action: 'delete_ride', ride_id: rid });
    });
    list.appendChild(card);
  });
}

// ── Scan status helper ────────────────────────────────────────────
function setScanStatus(text, spinning) {
  const el = document.getElementById('scan-status');
  if (!el) return;
  el.textContent = text;
  el.className   = 'scan-status' + (spinning ? ' scanning' : '');
}

// ── Utility ───────────────────────────────────────────────────────
function switchToWorkout(wid) {
  document.querySelector('[data-tab="ride"]').click();
  const sel = document.getElementById('workout-select');
  sel.value = wid;
  sel.dispatchEvent(new Event('change'));
}
window.switchToWorkout = switchToWorkout;

function fmtTime(sec) {
  if (sec == null || isNaN(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

let _toastTimer = null;
window.toast = function(msg, dur = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), dur);
};

function setMetric(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val != null ? val : '—';
}

function setControlsEnabled(on) {
  ['pause-btn', 'stop-btn', 'skip-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
  document.querySelectorAll('[data-offset]').forEach(b => { b.disabled = !on; });
  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.disabled = on || !state.selected;
}

function resetRideUI() {
  state.running = false;
  state.paused  = false;
  setControlsEnabled(false);
  document.getElementById('pause-btn').textContent = '⏸ Pause';
  document.getElementById('interval-fill').style.width = '0%';
  document.getElementById('adj-label').textContent = '±0W';
  setMetric('m-elapsed',   '0:00');
  setMetric('m-remaining', '—');
  setMetric('m-target',    '—');
  document.getElementById('interval-name').textContent  = 'Select a workout to begin';
  document.getElementById('interval-badge').textContent = '';
  document.getElementById('interval-countdown').textContent = '';
  if (window._rideChart) window._rideChart.reset();
  if (state.selected) previewWorkout(state.selected.id);
}

// ── DOMContentLoaded wiring ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory(_rides);
    });
  });

  // Workout select → preview
  document.getElementById('workout-select').addEventListener('change', e => previewWorkout(e.target.value));

  // FTP input → chart
  document.getElementById('ftp-input').addEventListener('input', e => {
    const ftp = parseInt(e.target.value, 10);
    if (ftp > 0) {
      state.ftp = ftp;
      if (window._rideChart) window._rideChart.setFTP(ftp);
    }
  });

  // Start
  document.getElementById('start-btn').addEventListener('click', () => {
    if (!state.selected) { toast('Select a workout first'); return; }
    const ftp      = parseInt(document.getElementById('ftp-input').value, 10) || 250;
    const simulate = document.getElementById('simulate-chk').checked;
    if (!state.trainerConn && !simulate) {
      toast('No trainer connected – workout will run without ERG');
    }
    window.sendWS({ action: 'start_workout', workout_id: state.selected.id, ftp, simulate });
    document.getElementById('interval-fill').style.width = '0%';
  });

  // Pause / Resume
  document.getElementById('pause-btn').addEventListener('click', () => {
    window.sendWS({ action: state.paused ? 'resume' : 'pause' });
  });

  // Stop
  document.getElementById('stop-btn').addEventListener('click', () => {
    if (confirm('Stop the workout?')) window.sendWS({ action: 'stop' });
  });

  // Skip
  document.getElementById('skip-btn').addEventListener('click', () => {
    window.sendWS({ action: 'skip_interval' });
  });

  // Power offset buttons
  document.querySelectorAll('[data-offset]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.sendWS({ action: 'adjust_power', offset: parseInt(btn.dataset.offset, 10) });
    });
  });

  // BLE connect / disconnect buttons
  const bleConnBtn = document.getElementById('ble-connect-btn');
  if (bleConnBtn) bleConnBtn.addEventListener('click', () => window.sendWS({ action: 'ble_connect' }));
  const discBtn = document.getElementById('disconnect-btn');
  if (discBtn) discBtn.addEventListener('click', () => window.sendWS({ action: 'ble_disconnect' }));

  // Init creator, planner, plan generator
  window._creator = new WorkoutCreator();
  window._planner = new CalendarPlanner();
  window._planGen = new PlanGenerator();

  window._pgClose = () => {
    const o = document.getElementById('pg-overlay');
    if (o) { o.style.display = 'none'; document.body.style.overflow = ''; }
  };

  // Today's plan banner → load into ride tab
  document.getElementById('today-plan-load').addEventListener('click', () => {
    const wid = document.getElementById('today-plan').dataset.workoutId;
    if (wid) switchToWorkout(wid);
  });
});
