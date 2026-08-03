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

let _sb      = null;
let _userId  = null;
let _ble     = null;
let _engine  = null;
let _strava  = null;
let _rides   = [];
let _plan    = {};
let _runs    = [];
let _runPlan = {};
let _profile = null;   // athlete_profiles row, or null before onboarding

// sendWS is the universal message bus — routes to _handleAction in web mode.
// _handleAction is async; without a .catch() here, any failure (a bad
// Postgrest call, a coach-state mismatch, etc.) becomes a silent unhandled
// promise rejection — the button just looks like it did nothing.
window.sendWS = msg => _handleAction(msg).catch(err => {
  console.error('Action failed:', msg.action, err);
  toast('Something went wrong — please try again.');
});

function _syncDashboard() {
  if (window._dashboard) window._dashboard.update({
    rides: _rides, plan: _plan, runs: _runs, runPlan: _runPlan,
  });
}

// Pushes run data into the calendar planner and the Run tab. Called
// whenever _runs or _runPlan change.
function _syncRunViews() {
  if (window._planner) window._planner.update({ runPlan: _runPlan, runs: _runs });
  if (window._runTab)  window._runTab.update({ runs: _runs });
}

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

  // Strava: restore connection, then handle an OAuth redirect if present
  _strava = new StravaManager(_sb, _userId);
  await _strava.init();
  const spq = new URLSearchParams(location.search);
  if (spq.has('code') || spq.has('error')) {
    const ok = await _strava.handleCallback();
    if (ok) {
      toast('Strava connected! Completed rides will sync automatically.');
      document.querySelector('[data-tab="devices"]')?.click();
    } else {
      toast(`Strava connection failed: ${_strava.lastError || 'unknown error'}`, 6000);
    }
  }
  updateStravaUI();

  await _loadInitialData();
  await _loadCoachData();

  // Pull any new Strava activities in the background
  if (_strava.isConnected()) _stravaSync();
};

// ── Strava activity import (both rides and runs) ──────────────────
async function _stravaSync() {
  try {
    const after = Math.floor(Date.now() / 1000) - 60 * 86400;   // last 60 days
    const acts  = await _strava.listActivities(after);
    if (!acts.length) return;

    const knownRideIds = new Set(_rides.filter(r => r.strava_id).map(r => r.strava_id));
    const knownRunIds  = new Set(_runs.filter(r => r.strava_id).map(r => r.strava_id));
    const ftp = _rides.find(r => r.ftp)?.ftp || state.ftp || 250;

    let importedRides = 0, importedRuns = 0;
    for (const act of acts) {
      if (StravaManager.isBike(act) && !knownRideIds.has(act.id)) {
        const ride = StravaManager.activityToRide(act, ftp);
        const { data } = await _sb.from('rides').insert({ user_id: _userId, ...ride }).select().single();
        if (data) { _rides.push(data); importedRides++; }
      } else if (StravaManager.isRun(act) && !knownRunIds.has(act.id)) {
        const run = StravaManager.activityToRun(act);
        const { data } = await _sb.from('runs').insert({ user_id: _userId, ...run }).select().single();
        if (data) { _runs.push(data); importedRuns++; }
      }
    }

    if (importedRides) {
      _rides.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      renderHistory(_rides);
      if (window._planner) window._planner.update({ rides: _rides });
      _syncDashboard();
      toast(`Imported ${importedRides} ride${importedRides === 1 ? '' : 's'} from Strava`);
      await _runAdaptation({ postAsCoachMessage: true });
      await _queueCheckinIfIdle();
    }

    if (importedRuns) {
      _runs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      _syncRunViews();
      _syncDashboard();
      toast(`Imported ${importedRuns} run${importedRuns === 1 ? '' : 's'} from Strava`);
      await _runRunAdaptation({ postAsCoachMessage: true });
      await _queueCheckinIfIdle();
    }
  } catch (e) {
    console.error('Strava sync:', e);
  }
}

// ── Adaptive plan: recompute and adjust the next generated workouts ──
async function _runAdaptation({ postAsCoachMessage = false } = {}) {
  const result = PlanWebEngine.computeAdaptation(_rides);
  if (postAsCoachMessage) {
    await _postCoachText(CoachEngineWeb.composeMessage('adaptation_result', result));
  }
  if (Math.abs(result.factor) < 0.005) return;

  const today   = new Date().toISOString().slice(0, 10);
  const entries = Object.entries(_plan)
    .filter(([d]) => d >= today)
    .sort(([a], [b]) => a.localeCompare(b));

  let adjusted = 0;
  for (const [, wid] of entries) {
    if (adjusted >= 3) break;
    const w = state.workouts.find(x => x.id === wid && (x.name || '').startsWith('FreeTrain · '));
    if (!w) continue;
    const adapted = PlanWebEngine.applyAdaptation(w, result.factor);
    if (JSON.stringify(adapted.intervals) === JSON.stringify(w.intervals)) continue;
    await _sb.from('workouts').update({ intervals: adapted.intervals }).eq('id', w.id);
    w.intervals = adapted.intervals;
    adjusted++;
  }
  if (adjusted && state.selected) previewWorkout(state.selected.id);
}

// ── Adaptive run plan: recompute and adjust the next planned run days ──
async function _runRunAdaptation({ postAsCoachMessage = false } = {}) {
  const result = RunPlanWebEngine.computeRunAdaptation(_runs, _runPlan);
  if (postAsCoachMessage) {
    await _postCoachText(CoachEngineWeb.composeMessage('adaptation_result', result));
  }
  if (Math.abs(result.factor) < 0.005) return;

  const today   = new Date().toISOString().slice(0, 10);
  const entries = Object.entries(_runPlan)
    .filter(([d, e]) => d >= today && (e.target_distance_m || 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 3);

  let adjusted = 0;
  for (const [dateStr, entry] of entries) {
    const adapted = RunPlanWebEngine.applyRunAdaptation(entry, result.factor);
    if (adapted.target_distance_m === entry.target_distance_m) continue;
    await _sb.from('run_plan_entries').update({
      target_distance_m:   adapted.target_distance_m,
      target_duration_min: adapted.target_duration_min,
    }).eq('user_id', _userId).eq('date', dateStr);
    _runPlan[dateStr] = { ..._runPlan[dateStr], ...adapted };
    adjusted++;
  }
  if (adjusted) _syncRunViews();
}

async function _loadInitialData() {
  const [workouts, rides, plan, runs, runPlan] = await Promise.all([
    _fetchWorkouts(), _fetchRides(), _fetchPlan(), _fetchRuns(), _fetchRunPlan(),
  ]);
  _rides   = rides;
  _plan    = plan;
  _runs    = runs;
  _runPlan = runPlan;

  updateWorkoutList(workouts);
  renderHistory(rides);
  if (window._planner) window._planner.update({ plan, workouts, rides, runPlan, runs });
  if (window._runTab)  window._runTab.update({ runs });
  _syncDashboard();

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

async function _fetchRuns() {
  const { data } = await _sb.from('runs').select('*')
    .eq('user_id', _userId).order('date', { ascending: false });
  return data || [];
}

async function _fetchRunPlan() {
  const { data } = await _sb.from('run_plan_entries').select('*').eq('user_id', _userId);
  const out = {};
  (data || []).forEach(e => { out[e.date] = e; });
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
      _syncDashboard();
      break;
    }

    // ── Run history ──────────────────────────────────────────────
    case 'get_runs':
      if (window._runTab) window._runTab.update({ runs: _runs });
      break;

    case 'delete_run': {
      await _sb.from('runs').delete().eq('id', msg.run_id).eq('user_id', _userId);
      _runs = _runs.filter(r => r.id !== msg.run_id);
      _syncRunViews();
      _syncDashboard();
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
      _syncDashboard();
      break;
    }

    // ── Coach chat ───────────────────────────────────────────────────
    case 'coach_reply':
      await _coachReply(msg.step, msg.value);
      break;

    case 'coach_checkin_reply':
      await _coachCheckinReply(msg.kind, msg.activity_id, msg.feedback);
      break;

    case 'coach_start_onboarding':
      await _coachStartOnboarding();
      break;

    case 'clear_calendar':
      await _clearCalendar();
      break;

    case 'clear_chat':
      await _clearChat();
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

  // Interval info (zoneName expects a fraction of FTP)
  const pct       = state.ftp ? msg.target / state.ftp : 0;
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

  // Adaptive plan: recompute and adjust upcoming generated workouts
  await _runAdaptation({ postAsCoachMessage: true });
  await _queueCheckinIfIdle();

  if (window._planner) window._planner.update({ rides: _rides });
  _syncDashboard();

  // Strava auto-upload (background — doesn't block the UI)
  if (data && _strava && _strava.isConnected()) {
    _stravaUpload(data.id, ride);
  }
}

async function _stravaUpload(rideId, ride) {
  toast('Uploading to Strava…');
  try {
    const activityId = await _strava.uploadRide(ride);
    if (!activityId) {
      toast('Strava upload failed — the ride is still saved in FreeTrain.');
      return;
    }
    await _sb.from('rides').update({ strava_id: activityId }).eq('id', rideId);
    const r = _rides.find(x => x.id === rideId);
    if (r) r.strava_id = activityId;
    renderHistory(_rides);
    toast('Ride uploaded to Strava');
  } catch (e) {
    console.error('Strava upload:', e);
    toast('Strava upload failed — the ride is still saved in FreeTrain.');
  }
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
  _syncDashboard();

  if (profile.ftp) {
    state.ftp = profile.ftp;
    const ftpInput = document.getElementById('ftp-input');
    if (ftpInput) ftpInput.value = profile.ftp;
  }

  toast(`6-week plan created — ${count} sessions scheduled.`);
  return count;
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
    _syncDashboard();
    toast('Generated plan cleared.');
  }
}

// ── Run plan generation ────────────────────────────────────────────
async function _generateRunPlan(profile) {
  const paces = _runs.map(r => r.avg_pace_sec_per_km).filter(Boolean);
  const avgPace = paces.length ? paces.reduce((a, b) => a + b, 0) / paces.length : 375.0;

  const sessions = RunPlanWebEngine.generateRunPlan({
    goal:            profile.goal,
    level:           profile.level,
    daysPerWeek:     profile.days_per_week,
    weeklyTargetM:   (profile.weekly_miles || 15) * 1609.34,
    avgPaceSecPerKm: avgPace,
  });

  await _clearGeneratedRunPlan(true);

  let count = 0;
  for (const { date, entry } of sessions) {
    await _sb.from('run_plan_entries').upsert({
      user_id:              _userId,
      date,
      run_type:             entry.run_type,
      target_distance_m:    entry.target_distance_m,
      target_duration_min:  entry.target_duration_min,
      description:          entry.description,
    }, { onConflict: 'user_id,date' });
    count++;
  }

  _runPlan = await _fetchRunPlan();
  _syncRunViews();
  toast(`6-week run plan created — ${count} runs scheduled.`);
  return count;
}

async function _clearGeneratedRunPlan(silent = false) {
  await _sb.from('run_plan_entries').delete().eq('user_id', _userId);
  if (!silent) {
    _runPlan = await _fetchRunPlan();
    _syncRunViews();
    toast('Generated run plan cleared.');
  }
}

// ── Clear calendar / clear chat ────────────────────────────────────
async function _clearCalendar() {
  await _clearGeneratedPlan(true);
  await _clearGeneratedRunPlan(true);

  const workouts = await _fetchWorkouts();
  _plan = await _fetchPlan();
  updateWorkoutList(workouts);
  if (window._planner) window._planner.update({ plan: _plan, workouts });
  _syncDashboard();

  _runPlan = await _fetchRunPlan();
  _syncRunViews();

  toast('Calendar cleared.');
}

async function _clearChat() {
  await CoachWeb.clearMessages(_sb, _userId);
  if (window._coach) window._coach.reset();
  await _loadCoachData();
}

// ── Coach chat ───────────────────────────────────────────────────────
// Onboarding survey + post-workout check-ins, driven entirely by
// CoachEngineWeb's rule-based state machine (the web twin of
// server/coach_engine.py). Conversation state lives in the coach_messages
// transcript itself — no separate "session" table needed.

async function _postCoachRow(role, text, messageType = 'plain', payload = {}) {
  const row = await CoachWeb.postMessage(_sb, _userId, role, text, messageType, payload);
  if (window._coach) window._coach.appendMessage(row);
  return row;
}

async function _postCoachText(text) {
  if (text) await _postCoachRow('coach', text);
}

async function _postCoachStep(step, profileSoFar) {
  const prompt = CoachEngineWeb.stepPrompt(step, profileSoFar);
  prompt.payload.profile_so_far = profileSoFar;
  await _postCoachRow('coach', prompt.text, prompt.message_type, prompt.payload);
}

async function _getPendingCoachStep() {
  const last = await CoachWeb.getLatestMessage(_sb, _userId);
  if (last && last.role === 'coach' && ['quick_reply', 'number_input', 'free_text'].includes(last.message_type)) {
    return last;
  }
  return null;
}

function _labelForReply(pending, value) {
  if (pending.message_type === 'quick_reply') {
    const opts  = pending.payload.options || [];
    const match = opts.find(o => o.value === value);
    if (match) return match.label;
  }
  return String(value);
}

async function _loadCoachData() {
  let profile  = await CoachWeb.getProfile(_sb, _userId);
  let messages = await CoachWeb.getMessages(_sb, _userId);
  if (!profile && !messages.length) {
    await _postCoachStep('discipline', {});
    messages = await CoachWeb.getMessages(_sb, _userId);
  }
  _profile = profile;
  if (window._coach) window._coach.mount({ profile, messages });
}

async function _finishOnboarding(profileSoFar) {
  const discipline = profileSoFar.discipline || 'both';
  const fields = {};

  if ((discipline === 'cycling' || discipline === 'both') && profileSoFar.bike_goal) {
    const days  = parseInt(profileSoFar.bike_days || '4', 10);
    const hours = parseFloat(profileSoFar.bike_hours || '5');
    fields.bike_style         = profileSoFar.bike_style || 'road';
    fields.bike_goal          = profileSoFar.bike_goal;
    fields.bike_level         = profileSoFar.bike_level || 'intermediate';
    fields.bike_days_per_week = days;
    fields.bike_weekly_hours  = hours;
    fields.bike_ftp           = profileSoFar.bike_ftp ? parseInt(profileSoFar.bike_ftp, 10) : null;
  }

  if ((discipline === 'running' || discipline === 'both') && profileSoFar.run_goal) {
    fields.run_style         = profileSoFar.run_style || 'road';
    fields.run_goal          = profileSoFar.run_goal;
    fields.run_level         = profileSoFar.run_level || 'intermediate';
    fields.run_days_per_week = parseInt(profileSoFar.run_days || '4', 10);
    fields.run_weekly_miles  = parseFloat(profileSoFar.run_miles || '15');
  }

  const notes = (profileSoFar.notes || '').trim();
  if (notes && notes.toLowerCase() !== 'skip') fields.notes = notes;

  fields.onboarded_at = new Date().toISOString();
  _profile = await CoachWeb.saveProfile(_sb, _userId, fields);

  const summaryBits = [];
  if (fields.bike_goal) {
    const n = await _generatePlan({
      goal:          fields.bike_goal,
      level:         fields.bike_level,
      days_per_week: fields.bike_days_per_week,
      session_mins:  Math.round((fields.bike_weekly_hours * 60) / Math.max(fields.bike_days_per_week, 1)),
      ftp:           fields.bike_ftp,
    });
    const bikeLabel = fields.bike_style === 'mountain' ? 'mountain biking' : 'cycling';
    summaryBits.push(`${n} ${bikeLabel} sessions`);
  }
  if (fields.run_goal) {
    const n = await _generateRunPlan({
      goal:          fields.run_goal,
      level:         fields.run_level,
      days_per_week: fields.run_days_per_week,
      weekly_miles:  fields.run_weekly_miles,
    });
    const runLabel = fields.run_style === 'trail' ? 'trail runs' : 'runs';
    summaryBits.push(`${n} ${runLabel}`);
  }

  const text = 'Your 6-week plan is ready' + (summaryBits.length
    ? ` — ${summaryBits.join(', ')} scheduled. I'll check in with you after every workout and adjust things as we go.`
    : ". Come back and tell me how each workout goes, and I'll adjust as we go.");
  await _postCoachRow('coach', text, 'plan_summary');
}

async function _coachReply(step, value) {
  const pending = await _getPendingCoachStep();
  if (!pending || pending.payload.step !== step) return;   // stale or duplicate reply — ignore

  const profileSoFar = { ...(pending.payload.profile_so_far || {}) };

  const label = _labelForReply(pending, value);
  await _postCoachRow('user', label, 'plain', { step, value });

  if (step === 'confirm') {
    if (value === 'restart') {
      await _postCoachStep('discipline', {});
    } else {
      await _finishOnboarding(profileSoFar);
    }
    return;
  }

  profileSoFar[step] = value;
  const discipline = profileSoFar.discipline || 'both';
  const nxt = CoachEngineWeb.nextStep(discipline, step) || 'confirm';
  await _postCoachStep(nxt, profileSoFar);
}

async function _queueCheckinIfIdle() {
  if (await _getPendingCoachStep()) return;
  if (!_profile || !_profile.onboarded_at) return;   // no retroactive check-ins before onboarding

  const since = _profile.onboarded_at;
  const ridesNeeding = await CoachWeb.ridesNeedingCheckin(_sb, _userId, since, 1);
  if (ridesNeeding.length) {
    const r = ridesNeeding[0];
    const prompt = CoachEngineWeb.checkinPrompt('ride', r.workout_name || 'your ride');
    prompt.payload.activity_id = r.id;
    await _postCoachRow('coach', prompt.text, prompt.message_type, prompt.payload);
    return;
  }

  const runsNeeding = await CoachWeb.runsNeedingCheckin(_sb, _userId, since, 1);
  if (runsNeeding.length) {
    const r = runsNeeding[0];
    const prompt = CoachEngineWeb.checkinPrompt('run', r.name || 'your run');
    prompt.payload.activity_id = r.id;
    await _postCoachRow('coach', prompt.text, prompt.message_type, prompt.payload);
  }
}

async function _coachCheckinReply(kind, activityId, feedback) {
  const pending = await _getPendingCoachStep();
  if (!pending || pending.payload.kind !== kind || pending.payload.activity_id !== activityId) return;

  const label = (CoachEngineWeb.CHECKIN_OPTIONS.find(o => o.value === feedback) || {}).label || feedback;
  await _postCoachRow('user', label, 'plain', { kind, activity_id: activityId, feedback });

  if (kind === 'ride') {
    await CoachWeb.setRideFeedback(_sb, activityId, feedback);
    const r = _rides.find(x => x.id === activityId);
    if (r) r.feedback = feedback;
    await _runAdaptation({ postAsCoachMessage: true });
  } else {
    await CoachWeb.setRunFeedback(_sb, activityId, feedback);
    const r = _runs.find(x => x.id === activityId);
    if (r) r.feedback = feedback;
    await _runRunAdaptation({ postAsCoachMessage: true });
  }

  await _queueCheckinIfIdle();
}

async function _coachStartOnboarding() {
  await _postCoachStep('discipline', {});
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
        ${ride.strava_id ? `<a class="strava-view" href="https://www.strava.com/activities/${ride.strava_id}" target="_blank" rel="noopener">View on Strava ↗</a>` : ''}
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

// ── Strava UI ─────────────────────────────────────────────────────
function updateStravaUI() {
  const status  = document.getElementById('strava-status-text');
  const connect = document.getElementById('strava-connect-btn');
  const disc    = document.getElementById('strava-disconnect-btn');
  if (!status) return;

  if (!StravaManager.isConfigured()) {
    status.textContent    = 'Not available on this deployment';
    connect.style.display = 'none';
    disc.style.display    = 'none';
    return;
  }
  if (_strava && _strava.isConnected()) {
    const name = _strava.athleteName();
    status.textContent    = name
      ? `Connected as ${name} — rides sync automatically`
      : 'Connected — rides sync automatically';
    connect.style.display = 'none';
    disc.style.display    = 'inline-flex';
  } else {
    status.textContent    = 'Not connected';
    connect.style.display = 'inline-flex';
    disc.style.display    = 'none';
  }
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
      if (btn.dataset.tab === 'dashboard') {
        renderHistory(_rides);
        if (window._dashboard) window._dashboard.refresh();
      }
      if (btn.dataset.tab === 'run' && window._runTab) {
        window._runTab.update({ runs: _runs });
      }
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

  // Strava connect / disconnect
  document.getElementById('strava-connect-btn')?.addEventListener('click', () => {
    if (!StravaManager.isConfigured()) { toast('Strava is not configured.'); return; }
    _strava.connect();
  });
  document.getElementById('strava-disconnect-btn')?.addEventListener('click', async () => {
    if (confirm('Disconnect Strava? New rides will no longer sync.')) {
      await _strava.disconnect();
      updateStravaUI();
      toast('Strava disconnected.');
    }
  });

  // Init creator, planner, dashboard, run tab, coach chat
  window._creator   = new WorkoutCreator();
  window._planner   = new CalendarPlanner();
  window._dashboard = new TrainingDashboard();
  window._runTab    = new RunTab();
  window._coach     = new CoachChat();

  // Today's plan banner → load into ride tab
  document.getElementById('today-plan-load').addEventListener('click', () => {
    const wid = document.getElementById('today-plan').dataset.workoutId;
    if (wid) switchToWorkout(wid);
  });
});
