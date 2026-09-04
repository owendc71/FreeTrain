'use strict';

/* ═══════════════════════════════════════════════════════════════════
   AICoachWeb – Claude-backed coach for the web build.

   The API key never touches the browser: this file POSTs to the
   /api/coach-chat serverless function, which pins the model, system
   prompt and tool schemas. Tools are DECLARED there but EXECUTED here,
   because this is where the plan engines (PlanWebEngine /
   RunPlanWebEngine) and the authenticated Supabase client already live.

   Conversation is persisted in the same `coach_messages` table the
   rule-based coach uses, so both can coexist and the transcript
   survives reloads. Only visible text is persisted — tool_use /
   tool_result blocks live for the duration of one exchange, so replayed
   history never contains an orphaned tool_result.
═══════════════════════════════════════════════════════════════════ */

const AICoachWeb = (() => {

  const ENDPOINT        = '/api/coach-chat';
  const MAX_TOOL_ROUNDS = 6;    // hard stop on the agentic loop
  const HISTORY_TURNS   = 24;   // replayed transcript depth (cost bound)

  let _available = null;        // null = untested, true/false once known
  let _busy      = false;

  const api = () => window.FreeTrainAI;

  // ── Public API ─────────────────────────────────────────────────────

  function isBusy() { return _busy; }

  // Did the endpoint report a working AI coach? null until first call.
  function availability() { return _available; }

  /**
   * Send one athlete message and run the tool loop to completion.
   * Persists both sides of the exchange and pushes bubbles into the UI.
   * Returns true if the AI answered, false if it's unavailable (caller
   * should fall back to the rule-based coach).
   */
  async function send(userText) {
    const text = (userText || '').trim();
    if (!text || _busy) return true;

    const seam = api();
    if (!seam) return false;

    _busy = true;
    _setThinking(true);

    try {
      // Persist + render the athlete's turn first, so it survives a failure.
      await seam.postCoachRow('user', text);

      const messages = await _buildHistory(seam);
      messages.push({ role: 'user', content: text });

      const context = await _buildContext(seam);
      let answered  = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const resp = await _call(messages, context, seam);
        if (resp === 'unavailable') { _available = false; return false; }
        _available = true;

        // Anything the model said out loud this round.
        const said = (resp.content || [])
          .filter(b => b.type === 'text' && b.text && b.text.trim())
          .map(b => b.text.trim())
          .join('\n\n');
        if (said) { await seam.postCoachRow('coach', said); answered = true; }

        if (resp.stop_reason === 'refusal') {
          if (!answered) {
            await seam.postCoachRow('coach',
              "I can't help with that one. Ask me something about your training and I'll dig in.");
          }
          return true;
        }

        if (resp.stop_reason !== 'tool_use') return true;

        // Echo the assistant turn back verbatim — thinking blocks included.
        messages.push({ role: 'assistant', content: resp.content });

        const results = [];
        for (const block of resp.content) {
          if (block.type !== 'tool_use') continue;
          const out = await _runTool(block.name, block.input || {}, seam);
          results.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify(out.data ?? out.error ?? null),
            ...(out.error ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: results });
      }

      // Ran out of rounds without a natural finish.
      if (!answered) {
        await seam.postCoachRow('coach',
          "I got a bit tangled up working through that — mind asking again?");
      }
      return true;

    } catch (err) {
      console.error('AI coach failed:', err);
      await api().postCoachRow('coach',
        "I couldn't reach my brain just then — check your connection and try again.");
      return true;
    } finally {
      _busy = false;
      _setThinking(false);
    }
  }

  // ── Transport ──────────────────────────────────────────────────────

  async function _call(messages, context, seam) {
    const token = await seam.getAccessToken();
    if (!token) return 'unavailable';

    const r = await fetch(ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ messages, context }),
    });

    if (r.status === 503) return 'unavailable';   // key not configured
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json()).error || ''; } catch { /* ignore */ }
      throw new Error(`coach-chat ${r.status}${detail ? `: ${detail}` : ''}`);
    }
    return r.json();
  }

  // ── History & context ──────────────────────────────────────────────

  // Replay the persisted transcript as plain text turns. Leading coach
  // messages are dropped because the API requires a user turn first.
  async function _buildHistory(seam) {
    const rows = await seam.getCoachMessages();
    const turns = rows
      .filter(m => (m.text || '').trim())
      .map(m => ({
        role:    m.role === 'user' ? 'user' : 'assistant',
        content: m.text.trim(),
      }));

    const recent = turns.slice(-HISTORY_TURNS);
    while (recent.length && recent[0].role !== 'user') recent.shift();
    return recent;
  }

  async function _buildContext(seam) {
    const p        = seam.getProfile();
    const rides    = seam.getRides().slice(0, 5);
    const runs     = seam.getRuns().slice(0, 5);
    const swims    = seam.getSwims().slice(0, 5);
    const strength = seam.getStrength().slice(0, 5);
    const today    = new Date().toISOString().slice(0, 10);

    const lines = [`Today's date: ${today}`];

    if (p) {
      const bits = [];
      if (p.bike_goal)     bits.push(`cycling goal ${p.bike_goal} (${p.bike_style || 'road'}, ${p.bike_level || '?'} level, ${p.bike_days_per_week ?? '?'} days/wk, ${p.bike_weekly_hours ?? '?'} hrs/wk${p.bike_ftp ? `, FTP ${p.bike_ftp}W` : ''})`);
      if (p.run_goal)      bits.push(`running goal ${p.run_goal} (${p.run_style || 'road'}, ${p.run_level || '?'} level, ${p.run_days_per_week ?? '?'} days/wk, ${p.run_weekly_miles ?? '?'} mi/wk)`);
      if (p.swim_goal)     bits.push(`swimming goal ${p.swim_goal} (${p.swim_level || '?'} level, ${p.swim_days_per_week ?? '?'} days/wk, ${p.swim_weekly_meters ?? '?'} m/wk)`);
      if (p.strength_goal) bits.push(`strength goal ${p.strength_goal} (${p.strength_level || '?'} level, ${p.strength_days_per_week ?? '?'} days/wk, ${p.strength_session_mins ?? '?'} min/session)`);
      if (p.notes)         bits.push(`notes: ${p.notes}`);
      lines.push(bits.length ? `Profile: ${bits.join('; ')}` : 'Profile: saved but empty.');
    } else {
      lines.push('Profile: none yet — this athlete has not been set up.');
    }

    const counts = [
      `${Object.keys(seam.getPlan() || {}).length} cycling`,
      `${Object.keys(seam.getRunPlan() || {}).length} running`,
      `${Object.keys(seam.getSwimPlan() || {}).length} swimming`,
      `${Object.keys(seam.getStrengthPlan() || {}).length} strength`,
    ];
    lines.push(`Calendar: ${counts.join(', ')} session(s) currently scheduled.`);

    if (rides.length)    lines.push('Recent rides: '    + rides.map(_rideLine).join(' | '));
    if (runs.length)     lines.push('Recent runs: '     + runs.map(_runLine).join(' | '));
    if (swims.length)    lines.push('Recent swims: '    + swims.map(_swimLine).join(' | '));
    if (strength.length) lines.push('Recent strength: ' + strength.map(_strengthLine).join(' | '));
    if (!rides.length && !runs.length && !swims.length && !strength.length) {
      lines.push('No completed activities recorded yet.');
    }

    return lines.join('\n');
  }

  function _rideLine(r) {
    const d = (r.date || '').slice(0, 10);
    const mins = r.elapsed ? Math.round(r.elapsed / 60) : null;
    return [
      d,
      r.workout_name || 'Ride',
      mins ? `${mins}min` : null,
      r.normalized_power ? `NP ${Math.round(r.normalized_power)}W` : null,
      r.tss ? `TSS ${Math.round(r.tss)}` : null,
      r.feedback ? `felt "${r.feedback}"` : null,
    ].filter(Boolean).join(' ');
  }

  function _runLine(r) {
    const d = (r.date || '').slice(0, 10);
    const mi = r.distance_m ? (r.distance_m / 1609.34).toFixed(1) : null;
    const mins = r.elapsed ? Math.round(r.elapsed / 60) : null;
    return [
      d,
      r.name || 'Run',
      mi ? `${mi}mi` : null,
      mins ? `${mins}min` : null,
      r.feedback ? `felt "${r.feedback}"` : null,
    ].filter(Boolean).join(' ');
  }

  function _swimLine(s) {
    const d = (s.date || '').slice(0, 10);
    const dist = s.distance_m
      ? (s.distance_m >= 1000 ? `${(s.distance_m / 1000).toFixed(1)}km` : `${Math.round(s.distance_m)}m`)
      : null;
    const mins = s.elapsed ? Math.round(s.elapsed / 60) : null;
    const pace = s.avg_pace_sec_per_100m
      ? `${Math.floor(s.avg_pace_sec_per_100m / 60)}:${String(Math.round(s.avg_pace_sec_per_100m % 60)).padStart(2, '0')}/100m`
      : null;
    return [
      d, s.name || 'Swim', dist,
      mins ? `${mins}min` : null,
      pace,
      s.stroke && s.stroke !== 'free' ? s.stroke : null,
      s.feedback ? `felt "${s.feedback}"` : null,
    ].filter(Boolean).join(' ');
  }

  function _strengthLine(s) {
    const d = (s.date || '').slice(0, 10);
    const mins = s.elapsed ? Math.round(s.elapsed / 60) : null;
    return [
      d, s.name || 'Strength',
      s.focus || null,
      mins ? `${mins}min` : null,
      s.perceived_effort ? `RPE ${s.perceived_effort}` : null,
      s.notes ? `notes: ${s.notes}` : null,
      s.feedback ? `felt "${s.feedback}"` : null,
    ].filter(Boolean).join(' ');
  }

  // ── Tool execution (runs in the browser, against the real engines) ──

  async function _runTool(name, input, seam) {
    try {
      switch (name) {

        case 'create_cycling_plan': {
          const days  = _clamp(parseInt(input.days_per_week, 10) || 4, 3, 7);
          const hours = Number(input.weekly_hours) || 5;
          const ftp   = input.ftp ? parseInt(input.ftp, 10) : null;
          const weeks = _clampWeeks(input.weeks);

          const n = await seam.generatePlan({
            goal:          input.goal  || 'base_fitness',
            level:         input.level || 'intermediate',
            days_per_week: days,
            session_mins:  Math.round((hours * 60) / Math.max(days, 1)),
            ftp,
            weeks,
          });

          await seam.saveProfile({
            bike_goal:          input.goal  || 'base_fitness',
            bike_level:         input.level || 'intermediate',
            bike_days_per_week: days,
            bike_weekly_hours:  hours,
            ...(ftp ? { bike_ftp: ftp } : {}),
            onboarded_at: seam.getProfile()?.onboarded_at || new Date().toISOString(),
          });

          return { data: { sessions_created: n, weeks, days_per_week: days } };
        }

        case 'create_run_plan': {
          const days  = _clamp(parseInt(input.days_per_week, 10) || 4, 3, 6);
          const miles = Number(input.weekly_miles) || 15;
          const weeks = _clampWeeks(input.weeks);

          const n = await seam.generateRunPlan({
            goal:          input.goal  || 'base_mileage',
            level:         input.level || 'intermediate',
            days_per_week: days,
            weekly_miles:  miles,
            weeks,
          });

          await seam.saveProfile({
            run_goal:          input.goal  || 'base_mileage',
            run_level:         input.level || 'intermediate',
            run_days_per_week: days,
            run_weekly_miles:  miles,
            onboarded_at: seam.getProfile()?.onboarded_at || new Date().toISOString(),
          });

          return { data: { runs_created: n, weeks, days_per_week: days } };
        }

        case 'create_swim_plan': {
          const days   = _clamp(parseInt(input.days_per_week, 10) || 3, 2, 6);
          const metres = Number(input.weekly_meters) || 6000;
          const weeks  = _clampWeeks(input.weeks);

          const n = await seam.generateSwimPlan({
            goal:          input.goal  || 'base_fitness',
            level:         input.level || 'intermediate',
            days_per_week: days,
            weekly_meters: metres,
            weeks,
          });

          await seam.saveProfile({
            swim_goal:          input.goal  || 'base_fitness',
            swim_level:         input.level || 'intermediate',
            swim_days_per_week: days,
            swim_weekly_meters: metres,
            onboarded_at: seam.getProfile()?.onboarded_at || new Date().toISOString(),
          });

          return { data: { swims_created: n, weeks, days_per_week: days } };
        }

        case 'create_strength_plan': {
          const days  = _clamp(parseInt(input.days_per_week, 10) || 3, 1, 5);
          const mins  = Number(input.session_mins) || 45;
          const weeks = _clampWeeks(input.weeks);

          const n = await seam.generateStrengthPlan({
            goal:          input.goal  || 'general_strength',
            level:         input.level || 'intermediate',
            days_per_week: days,
            session_mins:  mins,
            weeks,
          });

          await seam.saveProfile({
            strength_goal:          input.goal  || 'general_strength',
            strength_level:         input.level || 'intermediate',
            strength_days_per_week: days,
            strength_session_mins:  mins,
            onboarded_at: seam.getProfile()?.onboarded_at || new Date().toISOString(),
          });

          return { data: { sessions_created: n, weeks, days_per_week: days } };
        }

        case 'log_swim': {
          const distM = Number(input.distance_m) || 0;
          if (distM <= 0) return { error: 'distance_m must be greater than zero.' };
          const durMin = Number(input.duration_min) || 0;
          const swim = {
            name:       input.name || 'Swim',
            date:       _isoDay(input.date),
            distance_m: distM,
            elapsed:    Math.round(durMin * 60),
            stroke:     input.stroke || 'free',
            source:     'coach',
            // Pace is derived here so the swim engine and the history view
            // don't each have to guess at it.
            avg_pace_sec_per_100m: durMin > 0 ? Math.round((durMin * 60) / (distM / 100)) : 0,
          };
          const saved = await seam.logSwim(swim);
          return { data: { logged: true, date: swim.date, distance_m: distM, id: saved?.id ?? null } };
        }

        case 'log_strength': {
          const durMin = Number(input.duration_min) || 0;
          if (durMin <= 0) return { error: 'duration_min must be greater than zero.' };
          const session = {
            name:    input.name || 'Strength session',
            date:    _isoDay(input.date),
            focus:   input.focus || 'full',
            elapsed: Math.round(durMin * 60),
            notes:   input.notes || '',
            source:  'coach',
            ...(input.perceived_effort
                ? { perceived_effort: _clamp(parseInt(input.perceived_effort, 10), 1, 10) }
                : {}),
          };
          const saved = await seam.logStrength(session);
          return { data: { logged: true, date: session.date, focus: session.focus, id: saved?.id ?? null } };
        }

        case 'get_recent_activity': {
          const limit = _clamp(parseInt(input.limit, 10) || 10, 1, 30);
          const kind  = input.kind || 'all';
          const all   = kind === 'all' || kind === 'both';   // 'both' = legacy alias
          const out   = {};
          if (all || kind === 'rides')    out.rides    = seam.getRides().slice(0, limit).map(_rideLine);
          if (all || kind === 'runs')     out.runs     = seam.getRuns().slice(0, limit).map(_runLine);
          if (all || kind === 'swims')    out.swims    = seam.getSwims().slice(0, limit).map(_swimLine);
          if (all || kind === 'strength') out.strength = seam.getStrength().slice(0, limit).map(_strengthLine);

          const anything = ['rides', 'runs', 'swims', 'strength'].some(k => out[k]?.length);
          if (!anything) out.note = 'No completed activities recorded yet.';
          return { data: out };
        }

        case 'save_profile': {
          const allowed = [
            'bike_goal', 'bike_level', 'bike_style', 'bike_days_per_week',
            'bike_weekly_hours', 'bike_ftp', 'run_goal', 'run_level', 'run_style',
            'run_days_per_week', 'run_weekly_miles', 'notes',
          ];
          const fields = {};
          for (const k of allowed) {
            if (input[k] !== undefined && input[k] !== null) fields[k] = input[k];
          }
          if (!Object.keys(fields).length) {
            return { error: 'No recognised profile fields were provided.' };
          }
          await seam.saveProfile(fields);
          return { data: { saved: Object.keys(fields) } };
        }

        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      console.error(`AI coach tool ${name} failed:`, err);
      return { error: `${name} failed: ${err.message || err}` };
    }
  }

  function _clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }

  // Plan length bounds match all four engines.
  function _clampWeeks(w) {
    const n = parseInt(w, 10);
    return Number.isFinite(n) ? _clamp(n, 1, 24) : 6;
  }

  // Accept an ISO date from the model, but never trust it blindly —
  // fall back to today if it's missing or unparseable.
  function _isoDay(v) {
    const s = String(v || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00'))) return s;
    return new Date().toISOString().slice(0, 10);
  }

  // ── "Coach is thinking…" affordance ────────────────────────────────

  function _setThinking(on) {
    const el = document.getElementById('coach-thinking');
    if (el) el.style.display = on ? 'flex' : 'none';
    const input = document.getElementById('coach-text-input');
    const send  = document.getElementById('coach-text-send');
    if (input) input.disabled = on;
    if (send)  send.disabled  = on;
  }

  return { send, isBusy, availability };
})();

window.AICoachWeb = AICoachWeb;
