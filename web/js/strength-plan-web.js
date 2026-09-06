'use strict';

/* ═══════════════════════════════════════════════════════════════════
   StrengthPlanWebEngine – JS port of server/strength_plan_engine.py.
   Pure computation, no server needed.
═══════════════════════════════════════════════════════════════════ */

const StrengthPlanWebEngine = (() => {

  const TAPER_GOALS = new Set(['event_prep', 'peak_strength']);

  const FOCUS_DESCRIPTIONS = {
    upper: 'Upper body — pressing, pulling, and shoulder stability work.',
    lower: 'Lower body — squat and hinge patterns, single-leg work.',
    full:  'Full body — compound lifts hitting both upper and lower.',
    core:  'Core and stability — trunk, hips, and anti-rotation work.',
  };

  const FOCUS_PATTERNS = {
    1: ['full'],
    2: ['full', 'full'],
    3: ['upper', 'lower', 'full'],
    4: ['upper', 'lower', 'upper', 'lower'],
    5: ['upper', 'lower', 'core', 'upper', 'lower'],
  };

  const FOCUS_DURATION_MULT = { upper: 1.0, lower: 1.0, full: 1.05, core: 0.65 };

  // Python weekday() convention (Mon=0 … Sun=6) — see mondayIndex() below.
  const DAY_PATTERNS = {
    1: [2],                 // Wed
    2: [1, 4],              // Tue  Fri
    3: [0, 2, 4],           // Mon  Wed  Fri
    4: [0, 1, 3, 4],        // Mon  Tue  Thu  Fri
    5: [0, 1, 2, 3, 4],     // Mon-Fri
  };

  const DEFAULT_WEEKS        = 6;
  const MIN_WEEKS            = 1;
  const MAX_WEEKS            = 24;
  const DEFAULT_SESSION_MINS = 45;
  const WEEK_CAP             = 1.20;
  const MIN_SESSION          = 20;
  const MAX_SESSION          = 120;
  const DURATION_STEP_MIN    = 5;

  // Plans are prescriptions, not measurements: a coach writes "6 miles",
  // never "7.1 miles". Targets snap to a readable grid at generation and
  // again after adaptation rescales them. Mirrors snap_to() in
  // server/run_plan_engine.py.
  function snapTo(value, step, minimum) {
    if (!(step > 0)) return value;
    return Math.max(minimum || 0, Math.round(value / step) * step);
  }


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

  // DAY_PATTERNS use Python's weekday() convention, NOT JS getDay().
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

  function generateStrengthPlan({ goal, level, daysPerWeek, sessionMins, weeks, days }) {
    const [pattern, dpw] = resolveDays(days, daysPerWeek, 1, 5, DAY_PATTERNS);
    daysPerWeek = dpw;
    weeks       = Math.min(Math.max(parseInt(weeks, 10) || DEFAULT_WEEKS, MIN_WEEKS), MAX_WEEKS);
    const focusPattern = FOCUS_PATTERNS[daysPerWeek];
    const factors      = weekFactors(weeks, TAPER_GOALS.has(goal));

    const levelScale = { beginner: 0.80, intermediate: 1.0, advanced: 1.15 }[level] ?? 1.0;
    const baseMins   = (sessionMins || DEFAULT_SESSION_MINS) * levelScale;

    const entries = [];
    factors.forEach(wf => {
      focusPattern.forEach(focus => {
        let mins = baseMins * wf * FOCUS_DURATION_MULT[focus];
        mins = Math.round(Math.min(snapTo(mins, DURATION_STEP_MIN, MIN_SESSION), MAX_SESSION));
        entries.push({
          focus,
          target_duration_min: mins,
          description:         FOCUS_DESCRIPTIONS[focus],
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

  function computeStrengthAdaptation(sessions, planEntries) {
    const today = isoDate(new Date());

    const doneByDate = {};
    sessions.forEach(s => {
      const d = String(s.date || '').slice(0, 10);
      if (!d) return;
      doneByDate[d] = (doneByDate[d] || 0) + (s.elapsed || 0) / 60;
    });

    const pastPlanned = Object.entries(planEntries)
      .filter(([ds, e]) => ds <= today && (e.target_duration_min || 0) > 0)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 12);

    if (!pastPlanned.length) {
      return { factor: 0, status: 'on_track',
               message: 'Log your first planned strength session to unlock adaptive adjustments.' };
    }

    const scores = pastPlanned.map(([ds, e]) => {
      const target = e.target_duration_min || 1;
      return Math.min((doneByDate[ds] || 0) / target, 1.15);
    });
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const n   = scores.length;
    const pct = (avg * 100).toFixed(0);

    let factor, note;
    if      (avg >= 0.95) { factor = 0.08;  note = `Strong consistency — completing ${pct}% of planned time across your last ${n} sessions.`; }
    else if (avg >= 0.80) { factor = 0;     note = `Solid consistency (${pct}% of planned time).`; }
    else if (avg >= 0.60) { factor = -0.08; note = `Completing ${pct}% of planned time — upcoming sessions shortened slightly.`; }
    else                  { factor = -0.15; note = `Completing ${pct}% of planned time — sessions shortened to something more sustainable.`; }

    const fbNudges = { too_easy: 0.05, just_right: 0.0, too_hard: -0.07 };
    const fbByDate = {};
    sessions.forEach(s => {
      const d = String(s.date || '').slice(0, 10);
      if (d && s.feedback) fbByDate[d] = s.feedback;
    });
    const fbValues = pastPlanned.map(([ds]) => fbByDate[ds]).filter(Boolean);
    if (fbValues.length) {
      const fbDelta = fbValues.reduce((a, f) => a + (fbNudges[f] || 0), 0) / fbValues.length;
      if (Math.abs(fbDelta) >= 0.01) {
        factor += fbDelta;
        note += fbDelta > 0
          ? " You've told me recent sessions felt easy, so they're extended a little."
          : " You've flagged recent sessions as tough, so they're pulled back further.";
      }
      // Negative feedback always wins over a positive adherence bonus.
      if (fbDelta < 0) factor = Math.min(factor, fbDelta);
    }

    // Perceived effort over the last two weeks refines the same picture.
    const nowMs = new Date(today + 'T12:00:00').getTime();
    const efforts = sessions.filter(s => {
      const d = String(s.date || '').slice(0, 10);
      if (!d || !s.perceived_effort) return false;
      const t = new Date(d + 'T12:00:00').getTime();
      return !isNaN(t) && (nowMs - t) / 86400000 < 14;
    }).map(s => s.perceived_effort);

    if (efforts.length >= 2) {
      const meanRpe = efforts.reduce((a, b) => a + b, 0) / efforts.length;
      if (meanRpe >= 8.5) {
        factor -= 0.04;
        note += ` Recent sessions have averaged RPE ${meanRpe.toFixed(1)} — easing off to let you recover.`;
      } else if (meanRpe <= 4.0 && avg >= 0.80) {
        factor += 0.03;
        note += ` Recent sessions have averaged RPE ${meanRpe.toFixed(1)}, so there's room for more.`;
      }
    }

    factor = Math.max(-0.15, Math.min(0.10, factor));
    const status = factor > 0.02 ? 'adjusted_up' : factor < -0.02 ? 'adjusted_down' : 'on_track';
    if (status === 'on_track' && !note.endsWith('more.')) note += ' Plan is progressing as intended.';
    return { factor, status, message: note };
  }

  function applyStrengthAdaptation(entry, factor) {
    if (Math.abs(factor) < 0.005) return entry;
    const e = { ...entry };
    const dur = e.target_duration_min || 0;
    if (dur > 0) {
      e.target_duration_min = Math.round(Math.min(
        snapTo(dur * (1 + factor), DURATION_STEP_MIN, MIN_SESSION), MAX_SESSION));
    }
    return e;
  }

  return { generateStrengthPlan, computeStrengthAdaptation, applyStrengthAdaptation, weekFactors };
})();
