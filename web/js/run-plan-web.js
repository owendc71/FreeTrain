'use strict';

/* ═══════════════════════════════════════════════════════════════════
   RunPlanWebEngine – JS port of server/run_plan_engine.py.
   Pure computation, no server needed.
═══════════════════════════════════════════════════════════════════ */

const RunPlanWebEngine = (() => {

  const RACE_GOALS = new Set(['five_k', 'ten_k', 'half_marathon', 'marathon', 'ultra']);

  const DESCRIPTIONS = {
    recovery:  'Very easy shakeout run. Effort should feel almost too easy.',
    easy:      'Conversational effort. Builds aerobic base without added fatigue.',
    tempo:     "Comfortably hard, sustained effort — 'controlled discomfort.'",
    intervals: 'Faster intervals with recovery jogs between. Raises top-end speed.',
    long:      'Your longest run of the week. Steady, easy-to-moderate effort.',
  };

  const PACE_MULT = { recovery: 1.15, easy: 1.05, tempo: 0.92, intervals: 0.85, long: 1.08 };

  const DAY_PATTERNS = {
    3: [1, 3, 5],
    4: [1, 3, 5, 6],
    5: [0, 1, 3, 5, 6],
    6: [0, 1, 2, 4, 5, 6],
  };

  const SLOTS = {
    3: [['easy', 0.28], ['tempo', 0.30], ['long', 0.42]],
    4: [['easy', 0.20], ['tempo', 0.26], ['long', 0.40], ['recovery', 0.14]],
    5: [['recovery', 0.10], ['easy', 0.18], ['intervals', 0.22], ['long', 0.38], ['easy', 0.12]],
    6: [['recovery', 0.08], ['easy', 0.16], ['intervals', 0.18], ['tempo', 0.18], ['long', 0.32], ['easy', 0.08]],
  };

  const DEFAULT_PACE_SEC_PER_KM = 375.0;

  // Plan length. Mirrors run_plan_engine.py.
  const DEFAULT_WEEKS = 6;
  const MIN_WEEKS     = 1;
  const MAX_WEEKS     = 24;
  const WEEK_CAP      = 1.20;

  // 3:1 periodization of arbitrary length. At weeks=6 with taper=true
  // this reproduces the original [0.85,0.95,1.00,0.70,1.00,0.70].
  function weekFactors(weeks, taper) {
    const out = [];
    for (let i = 0; i < weeks; i++) {
      if (i % 4 === 3) {
        out.push(0.70);
      } else {
        const block = Math.floor(i / 4);
        const base  = [0.85, 0.95, 1.00][i % 4] + 0.15 * block;
        out.push(Math.round(Math.min(base, WEEK_CAP) * 100) / 100);
      }
    }
    if (taper && weeks >= 2) out[out.length - 1] = 0.70;
    return out;
  }


  // Work out which weekdays to train on. An explicit `days` list (Python
  // weekday numbers, Mon=0 … Sun=6) wins over daysPerWeek, so a caller can
  // pin an exact weekly layout — necessary when several disciplines share
  // one calendar and must not collide. Mirrors resolve_days() in
  // server/run_plan_engine.py.
  function resolveDays(days, daysPerWeek, lo, hi, fallback) {
    if (Array.isArray(days) && days.length) {
      let pattern = [...new Set(days.map(d => ((parseInt(d, 10) % 7) + 7) % 7))].sort((a, b) => a - b);
      if (pattern.length) {
        const n = Math.min(Math.max(pattern.length, lo), hi);
        pattern = pattern.slice(0, n);
        if (pattern.length < n) {
          for (const d of [2, 5, 0, 3, 6, 1, 4]) {
            if (pattern.length >= n) break;
            if (!pattern.includes(d)) pattern.push(d);
          }
          pattern.sort((a, b) => a - b);
        }
        return [pattern, n];
      }
    }
    const n = Math.min(Math.max(parseInt(daysPerWeek, 10) || lo, lo), hi);
    return [fallback[n], n];
  }

  // DAY_PATTERNS above use Python's weekday() convention (Mon=0 … Sun=6),
  // NOT JS getDay() (Sun=0 … Sat=6). Convert before comparing, so this
  // file and run_plan_engine.py schedule the same weekdays.
  function mondayIndex(d) { return (d.getDay() + 6) % 7; }

  function nextMonday(d) {
    const r = new Date(d);
    const delta = (7 - mondayIndex(r)) % 7;
    r.setDate(r.getDate() + delta);
    return r;
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function generateRunPlan({ goal, level, daysPerWeek, weeklyTargetM, avgPaceSecPerKm, weeks, days }) {
    const [pattern, dpw] = resolveDays(days, daysPerWeek, 3, 6, DAY_PATTERNS);
    daysPerWeek = dpw;
    weeks       = Math.min(Math.max(parseInt(weeks, 10) || DEFAULT_WEEKS, MIN_WEEKS), MAX_WEEKS);
    const slots   = SLOTS[daysPerWeek];
    const factors = weekFactors(weeks, RACE_GOALS.has(goal));

    const levelScale = { beginner: 0.90, intermediate: 1.0, advanced: 1.10 }[level] ?? 1.0;
    const baseWeekly  = Math.max(weeklyTargetM * levelScale, 8000);
    const pace        = avgPaceSecPerKm > 0 ? avgPaceSecPerKm : DEFAULT_PACE_SEC_PER_KM;

    const entries = [];
    factors.forEach(wf => {
      const weekM = baseWeekly * wf;
      slots.forEach(([rtype, weight]) => {
        const distM   = Math.round(weekM * weight);
        const durMin  = Math.round((distM / 1000) * (pace * PACE_MULT[rtype]) / 60 * 10) / 10;
        entries.push({
          run_type:            rtype,
          target_distance_m:   distM,
          target_duration_min: durMin,
          description:         DESCRIPTIONS[rtype],
        });
      });
    });

    const dates   = [];
    let cursor    = nextMonday(new Date());
    while (dates.length < entries.length) {
      if (pattern.includes(mondayIndex(cursor))) dates.push(isoDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    return entries.map((entry, i) => ({ date: dates[i], entry }));
  }

  function computeRunAdaptation(runs, planEntries) {
    const today = isoDate(new Date());

    const completedByDate = {};
    runs.forEach(r => {
      const d = String(r.date || '').slice(0, 10);
      if (!d) return;
      completedByDate[d] = (completedByDate[d] || 0) + (r.distance_m || 0);
    });

    const pastPlanned = Object.entries(planEntries)
      .filter(([ds, e]) => ds <= today && (e.target_distance_m || 0) > 0)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 12);

    if (!pastPlanned.length) {
      return { factor: 0, status: 'on_track', message: 'Complete your first planned run to unlock adaptive adjustments.' };
    }

    const scores = pastPlanned.map(([ds, e]) => {
      const target = e.target_distance_m || 1;
      const actual = completedByDate[ds] || 0;
      return Math.min(actual / target, 1.15);
    });
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const n   = scores.length;
    const pct = (avg * 100).toFixed(0);

    let factor, note;
    if      (avg >= 0.95) { factor = 0.08;  note = `Strong adherence — hitting ${pct}% of planned mileage across your last ${n} runs.`; }
    else if (avg >= 0.80) { factor = 0;     note = `Solid consistency (${pct}% of planned mileage).`; }
    else if (avg >= 0.60) { factor = -0.08; note = `Hitting ${pct}% of planned mileage — upcoming distances eased slightly.`; }
    else                  { factor = -0.15; note = `Hitting ${pct}% of planned mileage — significant volume reduction applied.`; }

    const now = Date.now();
    let acute = 0, chronic = 0;
    runs.forEach(r => {
      const d = String(r.date || '').slice(0, 10);
      if (!d) return;
      const dDate = new Date(d + 'T12:00:00');
      if (isNaN(dDate)) return;
      const daysAgo = (now - dDate.getTime()) / 86400000;
      const m = r.distance_m || 0;
      if (daysAgo >= 0 && daysAgo < 7)       acute   += m;
      else if (daysAgo >= 7 && daysAgo < 28) chronic += m;
    });

    const chronicWeekly = chronic / 3;
    if (chronicWeekly >= 8000) {
      const ramp = acute / chronicWeekly;
      if (ramp > 1.30) {
        factor -= 0.06;
        note += ` Weekly mileage is ramping fast (${(acute/1000).toFixed(1)}km vs a ${(chronicWeekly/1000).toFixed(1)}km/week average) — volume pulled back to protect against injury.`;
      } else if (ramp < 0.60 && avg >= 0.80) {
        factor += 0.03;
        note += ' Recent mileage has been light, so there\'s room to build.';
      }
    }

    // ── Signal 3: subjective feedback nudge ──────────────────────────
    const fbNudges = { too_easy: 0.04, just_right: 0.0, too_hard: -0.06 };
    const fbByDate = {};
    runs.forEach(r => {
      const d = String(r.date || '').slice(0, 10);
      if (d && r.feedback) fbByDate[d] = r.feedback;   // last one wins if same-day dupes
    });
    const fbValues = pastPlanned.map(([ds]) => fbByDate[ds]).filter(Boolean);
    if (fbValues.length) {
      const fbDelta = fbValues.reduce((s, f) => s + (fbNudges[f] || 0), 0) / fbValues.length;
      if (Math.abs(fbDelta) >= 0.01) {
        factor += fbDelta;
        note += fbDelta > 0
          ? " You've told me recent runs felt easy, so upcoming volume is nudged up a bit more."
          : " You've flagged recent runs as tough, so upcoming volume is eased back further.";
      }
      // Hitting every target doesn't justify more mileage when the runner
      // is telling us it's too hard — negative feedback always wins over
      // a positive adherence bonus.
      if (fbDelta < 0) factor = Math.min(factor, fbDelta);
    }

    factor = Math.max(-0.15, Math.min(0.10, factor));
    const status = factor > 0.02 ? 'adjusted_up' : factor < -0.02 ? 'adjusted_down' : 'on_track';
    if (status === 'on_track' && !note.endsWith('build.')) note += ' Plan is progressing as intended.';
    return { factor, status, message: note };
  }

  function applyRunAdaptation(entry, factor) {
    if (Math.abs(factor) < 0.005) return entry;
    const e = { ...entry };
    const dist = e.target_distance_m || 0;
    const dur  = e.target_duration_min || 0;
    if (dist > 0) e.target_distance_m   = Math.max(Math.round(dist * (1 + factor)), 800);
    if (dur  > 0) e.target_duration_min = Math.round(dur * (1 + factor) * 10) / 10;
    return e;
  }

  return { generateRunPlan, computeRunAdaptation, applyRunAdaptation };
})();
