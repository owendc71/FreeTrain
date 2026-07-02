/* ═══════════════════════════════════════════════════════════════════
   FreeTrain – main app controller
   Handles: WebSocket, ride state, device management, UI updates
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── State ────────────────────────────────────────────────────────
const state = {
  workouts:    [],
  selected:    null,   // workout object
  ftp:         250,
  running:     false,
  paused:      false,
  trainerConn: false,
  pmConn:      false,

  // live workout
  totalDuration:    0,
  totalElapsed:     0,
  intervalIdx:      0,
  intervalElapsed:  0,
  intervalDuration: 0,
  targetPower:      0,
  powerOffset:      0,
  currentPower:     null,
  cadence:          null,
  heartRate:        null,
};

// ─── WebSocket ────────────────────────────────────────────────────
let ws       = null;
let wsReady  = false;
let wsQueue  = [];
let _wsToken = null;   // set by startApp()

function connectWS() {
  if (!_wsToken) return;
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(_wsToken)}`);

  ws.onopen = () => {
    wsReady = true;
    wsQueue.forEach(m => ws.send(JSON.stringify(m)));
    wsQueue = [];
  };

  ws.onmessage = e => handleMessage(JSON.parse(e.data));

  ws.onclose = e => {
    wsReady = false;
    if (e.code === 4001) {
      // Auth rejected — clear token and reload to show login
      localStorage.removeItem('wr_token');
      localStorage.removeItem('wr_username');
      location.reload();
      return;
    }
    setTimeout(connectWS, 2000);   // auto-reconnect
  };

  ws.onerror = () => ws.close();
}

window.sendWS = function(msg) {
  if (wsReady) ws.send(JSON.stringify(msg));
  else         wsQueue.push(msg);
};

// ─── Message handler ──────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'init':
      updateWorkoutList(msg.workouts);
      updateDeviceStatus(msg);
      if (msg.rides) renderHistory(msg.rides);
      if (window._planner) window._planner.update({
        plan: msg.plan, workouts: msg.workouts, rides: msg.rides || [],
      });
      break;

    case 'workouts_updated':
      updateWorkoutList(msg.workouts);
      if (window._planner) window._planner.update({ workouts: msg.workouts });
      break;

    case 'scanning':
      setScanStatus(msg.scanning ? 'Scanning for devices…' : '', msg.scanning);
      break;

    case 'scan_results':
      renderScanResults(msg.devices || []);
      setScanStatus(msg.devices.length ? `Found ${msg.devices.length} device(s)` : 'No fitness devices found.', false);
      break;

    case 'connecting':
      setScanStatus(`Connecting to ${msg.device_id}…`, true);
      break;

    case 'device_status':
      updateDeviceStatus(msg);
      if (msg.connect_success === false) toast('Connection failed. Is another app using the trainer?');
      break;

    case 'live_data':
      updateLiveData(msg);
      break;

    case 'workout_status':
      updateWorkoutStatus(msg);
      break;

    case 'workout_finished':
      onWorkoutFinished(msg);
      break;

    case 'history_updated':
      renderHistory(msg.rides || []);
      if (window._planner) window._planner.update({ rides: msg.rides || [] });
      break;

    case 'plan_updated':
      if (window._planner) window._planner.update({ plan: msg.plan });
      break;

    case 'plan_generated':
      toast(msg.message || 'Training plan created!');
      if (msg.ftp) {
        state.ftp = msg.ftp;
        const ftpInput = document.getElementById('ftp-input');
        if (ftpInput) ftpInput.value = msg.ftp;
      }
      break;

    case 'plan_cleared':
      toast('Generated plan cleared.');
      break;

    case 'adaptation_feedback':
      if (window._planGen) window._planGen.showInsights(msg);
      break;

    case 'error':
      toast(msg.message || 'An error occurred');
      break;
  }
}

// ─── Workout list ─────────────────────────────────────────────────
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

  // Re-select and preview if one was already selected
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

  document.getElementById('start-btn').disabled = false;
  setIntervalInfo(`${w.intervals.length} intervals  ·  ${fmtTime(w.total_duration)}`, '', '');
}

// ─── Device status ────────────────────────────────────────────────
function updateDeviceStatus(msg) {
  state.trainerConn = msg.trainer_connected || false;
  state.pmConn      = msg.pm_connected      || false;

  // Header pill
  const dot   = document.getElementById('trainer-dot');
  const label = document.getElementById('trainer-label');
  if (state.trainerConn) {
    dot.className        = 'status-dot connected';
    label.textContent    = msg.trainer_name || 'Trainer';
  } else {
    dot.className        = 'status-dot disconnected';
    label.textContent    = 'No Trainer';
  }

  // Devices tab
  const dn = document.getElementById('dc-trainer-name');
  const db = document.getElementById('dc-trainer-badge');
  if (state.trainerConn) {
    dn.textContent   = msg.trainer_name || 'Smart Trainer';
    db.textContent   = 'Connected';
    db.className     = 'device-badge connected';
  } else {
    dn.textContent   = 'No Trainer';
    db.textContent   = '—';
    db.className     = 'device-badge disconnected';
  }

  const pn = document.getElementById('dc-pm-name');
  const pb = document.getElementById('dc-pm-badge');
  if (state.pmConn) {
    pn.textContent = msg.pm_name || 'Power Meter';
    pb.textContent = 'Connected';
    pb.className   = 'device-badge connected';
  } else {
    pn.textContent = 'No Power Meter';
    pb.textContent = '—';
    pb.className   = 'device-badge disconnected';
  }

  const discBtn = document.getElementById('disconnect-btn');
  discBtn.style.display = (state.trainerConn || state.pmConn) ? 'block' : 'none';
}

// ─── Live data ────────────────────────────────────────────────────
function updateLiveData(msg) {
  if (msg.power   != null) state.currentPower = msg.power;
  if (msg.cadence != null) state.cadence      = msg.cadence;
  if (msg.heart_rate != null) state.heartRate = msg.heart_rate;

  setMetric('m-power',   state.currentPower, 'W');
  setMetric('m-cadence', state.cadence != null ? Math.round(state.cadence) : null, '');
  setMetric('m-hr',      state.heartRate, '');
  // Chart tick is driven by _renderClock (runs every second with correct elapsed)
}

function setMetric(id, val, _unit) {
  const el = document.getElementById(id);
  if (el) el.textContent = val != null ? val : '—';
}

// ─── Local display clock ─────────────────────────────────────────
// Drives the time display independently of WebSocket round-trips so
// the clock ticks smoothly even under latency.
let _tickTimer    = null;
let _localElapsed = 0;   // mirrors total_elapsed; display source of truth
let _localIvSec   = 0;   // mirrors interval_elapsed

function _startTick() {
  if (_tickTimer) return;
  _tickTimer = setInterval(() => {
    if (!state.running || state.paused) return;
    _localElapsed++;
    _localIvSec++;
    _renderClock();
  }, 1000);
}

function _stopTick() {
  clearInterval(_tickTimer);
  _tickTimer = null;
}

function _renderClock() {
  setMetric('m-elapsed',   fmtTime(_localElapsed));
  setMetric('m-remaining', fmtTime(Math.max(0, state.totalDuration - _localElapsed)));

  const ivRemain = Math.max(0, state.intervalDuration - _localIvSec);
  const countdown = document.getElementById('interval-countdown');
  if (countdown) countdown.textContent = fmtTime(ivRemain);

  const pctDone = state.intervalDuration
    ? Math.min(100, (_localIvSec / state.intervalDuration) * 100)
    : 0;
  const fill = document.getElementById('interval-fill');
  if (fill) fill.style.width = pctDone + '%';

  if (window._rideChart) {
    window._rideChart.tick(_localElapsed, state.currentPower);
  }
}

// ─── Workout status ───────────────────────────────────────────────
function updateWorkoutStatus(msg) {
  if (msg.state === 'stopped') {
    resetRideUI();
    return;
  }

  const wasRunning      = state.running;
  state.running         = msg.state === 'running';
  state.paused          = msg.state === 'paused';
  state.totalDuration   = msg.total_duration   ?? state.totalDuration;
  state.intervalDuration = msg.interval_duration ?? state.intervalDuration;
  state.targetPower     = msg.target_power     ?? state.targetPower;
  state.powerOffset     = msg.power_offset     ?? state.powerOffset;

  // Sync clock counters from server (source of truth)
  if (msg.total_elapsed    != null) _localElapsed = msg.total_elapsed;
  // Reset interval clock when interval index changes
  if (msg.interval_idx != null && msg.interval_idx !== state.intervalIdx) {
    _localIvSec = 0;
  } else if (msg.interval_elapsed != null) {
    _localIvSec = msg.interval_elapsed;
  }
  if (msg.interval_idx != null) state.intervalIdx = msg.interval_idx;

  // Start / stop local tick
  if (state.running)  _startTick();
  if (state.paused)   _stopTick();

  // Controls row
  const controls = document.getElementById('workout-controls');
  if (controls) controls.style.display = 'flex';
  const pauseBtn = document.getElementById('pause-btn');
  if (pauseBtn) pauseBtn.textContent = state.paused ? '▶ Resume' : '⏸ Pause';

  // Target power + offset
  setMetric('m-target', state.targetPower || '—');
  const adjLabel = document.getElementById('adj-label');
  if (adjLabel) {
    const adj = state.powerOffset;
    adjLabel.textContent = adj === 0 ? '±0W' : (adj > 0 ? `+${adj}W` : `${adj}W`);
  }

  // Interval name + badge
  const pct    = msg.interval_power_pct || 0;
  const zone   = msg.interval_zone      || '';
  const ivName = msg.interval_name      || zone;
  const ivIdx  = (msg.interval_idx ?? 0) + 1;
  const ivTotal = msg.intervals_total ?? '?';
  const ivBadge = `${ivIdx}/${ivTotal}  ${WorkoutChart.zoneName(pct)}`;
  document.getElementById('interval-name').textContent  = ivName;
  document.getElementById('interval-badge').textContent = ivBadge;
  const badge = document.getElementById('interval-badge');
  if (badge) badge.className = `interval-badge badge-${zone}`;

  // Render clock immediately so display snaps to server value
  _renderClock();
}

function setIntervalInfo(name, badge, countdown) {
  document.getElementById('interval-name').textContent      = name;
  document.getElementById('interval-badge').textContent     = badge || '';
  document.getElementById('interval-countdown').textContent = countdown || '';
}

function onWorkoutFinished(msg) {
  toast(`Workout complete! ${fmtTime(msg.total_elapsed)} · ${msg.workout_name}`);
  resetRideUI();
}

function resetRideUI() {
  state.running = false;
  state.paused  = false;

  _stopTick();
  _localElapsed = 0;
  _localIvSec   = 0;

  document.getElementById('workout-controls').style.display = 'none';
  document.getElementById('pause-btn').textContent = '⏸ Pause';
  document.getElementById('interval-fill').style.width = '0%';
  document.getElementById('adj-label').textContent = '±0W';

  setMetric('m-elapsed',   '0:00');
  setMetric('m-remaining', '—');
  setMetric('m-target',    '—');
  setIntervalInfo('Select a workout to begin', '', '');

  if (window._rideChart) window._rideChart.reset();
  if (state.selected) previewWorkout(state.selected.id);
}

// ─── Scan / devices ───────────────────────────────────────────────
function setScanStatus(text, spinning) {
  const el = document.getElementById('scan-status');
  el.textContent = text;
  el.className   = 'scan-status' + (spinning ? ' scanning' : '');
  if (spinning) el.textContent = text;
}

function renderScanResults(devices) {
  const list = document.getElementById('device-list');
  list.innerHTML = '';

  if (!devices.length) return;

  devices.forEach(d => {
    const div = document.createElement('div');
    div.className = 'found-device';
    div.innerHTML = `
      <div class="found-device-name">${d.name}</div>
      <div class="found-device-rssi">${d.rssi ?? '?'} dBm</div>
      <div class="found-device-btns">
        <button class="btn btn-connect-trainer" data-id="${d.id}">Trainer</button>
        <button class="btn btn-connect-pm"      data-id="${d.id}">Power Meter</button>
      </div>
    `;
    div.querySelector('.btn-connect-trainer').addEventListener('click', () => {
      window.sendWS({ action: 'connect', device_id: d.id, role: 'trainer' });
    });
    div.querySelector('.btn-connect-pm').addEventListener('click', () => {
      window.sendWS({ action: 'connect', device_id: d.id, role: 'power_meter' });
    });
    list.appendChild(div);
  });
}

// ─── Utility ──────────────────────────────────────────────────────
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

// ─── History ──────────────────────────────────────────────────────

function renderHistory(rides) {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const count = document.getElementById('history-count');

  list.innerHTML = '';
  count.textContent = rides.length ? `${rides.length} ride${rides.length === 1 ? '' : 's'}` : '';

  if (!rides.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  rides.forEach(ride => {
    const card = document.createElement('div');
    card.className = 'ride-card';

    const date = ride.date
      ? new Date(ride.date).toLocaleString(undefined, {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit',
        })
      : '—';

    const avgP = ride.avg_power        ? Math.round(ride.avg_power)         : '—';
    const np   = ride.normalized_power ? Math.round(ride.normalized_power)  : '—';
    const ifV  = ride.intensity_factor ? ride.intensity_factor.toFixed(2)   : '—';
    const tss  = ride.tss              ? Math.round(ride.tss)               : '—';
    const dur  = fmtTime(ride.elapsed);

    const badgeClass = ride.completed ? 'completed' : 'incomplete';
    const badgeText  = ride.completed ? 'Completed' : 'Partial';

    card.innerHTML = `
      <div>
        <div class="ride-card-title">${ride.workout_name || 'Workout'}</div>
        <div class="ride-card-date">${date} · FTP ${ride.ftp ?? '—'}W</div>
      </div>
      <span class="ride-card-badge ${badgeClass}">${badgeText}</span>

      <div class="ride-card-stats">
        <div class="ride-stat">
          <span class="ride-stat-value">${dur}</span>
          <span class="ride-stat-label">Duration</span>
        </div>
        <div class="ride-stat">
          <span class="ride-stat-value">${avgP}W</span>
          <span class="ride-stat-label">Avg Power</span>
        </div>
        <div class="ride-stat">
          <span class="ride-stat-value">${np}W</span>
          <span class="ride-stat-label">Norm Power</span>
        </div>
        <div class="ride-stat">
          <span class="ride-stat-value">${ifV}</span>
          <span class="ride-stat-label">IF</span>
        </div>
        <div class="ride-stat">
          <span class="ride-stat-value">${tss}</span>
          <span class="ride-stat-label">TSS</span>
        </div>
      </div>

      <div class="ride-card-actions">
        <button class="btn btn-stop" data-delete="${ride.id}" style="font-size:12px;padding:5px 12px">
          Delete
        </button>
      </div>
    `;

    card.querySelector('[data-delete]').addEventListener('click', e => {
      const rid = e.currentTarget.dataset.delete;
      if (confirm('Delete this ride?')) {
        window.sendWS({ action: 'delete_ride', ride_id: rid });
      }
    });

    list.appendChild(card);
  });
}

// ─── App startup (called by auth.js after login) ──────────────────
window.startApp = function(token, serverFtp) {
  _wsToken = token;
  if (serverFtp) {
    state.ftp = serverFtp;
    const ftpInput = document.getElementById('ftp-input');
    if (ftpInput) ftpInput.value = serverFtp;
  }
  connectWS();
};

// ─── UI event wiring ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'history') window.sendWS({ action: 'get_history' });
    });
  });

  // Workout select → preview
  document.getElementById('workout-select').addEventListener('change', e => {
    previewWorkout(e.target.value);
  });

  // FTP input → update chart
  document.getElementById('ftp-input').addEventListener('input', e => {
    const ftp = parseInt(e.target.value, 10);
    if (ftp > 0) {
      state.ftp = ftp;
      if (window._rideChart) window._rideChart.setFTP(ftp);
    }
  });

  // Start button
  document.getElementById('start-btn').addEventListener('click', () => {
    if (!state.selected) { toast('Select a workout first'); return; }
    const ftp      = parseInt(document.getElementById('ftp-input').value, 10) || 250;
    const simulate = document.getElementById('simulate-chk').checked;
    if (!state.trainerConn && !simulate) {
      toast('No trainer connected – workout will run without ERG control');
    }
    window.sendWS({
      action:     'start_workout',
      workout_id: state.selected.id,
      ftp,
      simulate,
    });
    document.getElementById('workout-controls').style.display = 'flex';
    document.getElementById('interval-fill').style.width = '0%';
  });

  // Pause / Resume
  document.getElementById('pause-btn').addEventListener('click', () => {
    window.sendWS({ action: state.paused ? 'resume' : 'pause' });
  });

  // Stop
  document.getElementById('stop-btn').addEventListener('click', () => {
    if (confirm('Stop the workout?')) {
      window.sendWS({ action: 'stop' });
    }
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

  // Scan button
  document.getElementById('scan-btn').addEventListener('click', () => {
    document.getElementById('device-list').innerHTML = '';
    window.sendWS({ action: 'scan' });
  });

  // Disconnect all
  document.getElementById('disconnect-btn').addEventListener('click', () => {
    window.sendWS({ action: 'disconnect' });
  });

  // Init creator and planner
  window._creator = new WorkoutCreator();
  window._planner = new CalendarPlanner();
  window._planGen = new PlanGenerator();

  // Wire plan generator open button here so it works even if PlanGenerator
  // constructor has a partial failure earlier in the chain.
  // Open/close for plan generator modal — handled via onclick in HTML.
  // These globals let PlanGenerator.js call close programmatically (e.g. after generate).
  window._pgClose = () => {
    const o = document.getElementById('pg-overlay');
    if (o) { o.style.display = 'none'; document.body.style.overflow = ''; }
  };

  // Today's plan banner → load that workout into the Ride tab
  document.getElementById('today-plan-load').addEventListener('click', () => {
    const wid = document.getElementById('today-plan').dataset.workoutId;
    if (wid) switchToWorkout(wid);
  });

  // WebSocket is started by startApp() after auth — do NOT call connectWS() here
});
