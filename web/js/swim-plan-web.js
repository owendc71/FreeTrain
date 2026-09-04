'use strict';

/* ═══════════════════════════════════════════════════════════════════
   SwimPlanWebEngine – JS port of server/swim_plan_engine.py.
   Pure computation, no server needed.
═══════════════════════════════════════════════════════════════════ */

const SwimPlanWebEngine = (() => {

  const RACE_GOALS = new Set(['distance_event', 'race_prep', 'triathlon']);

  const DESCRIPTIONS = {
    recovery:  'Easy loosener. Long, relaxed strokes — should feel almost too easy.',
    technique: 'Drill-focused set. Prioritise stroke quality over speed or effort.',
    easy:      'Steady aerobic swimming at a conversational effort.',
    threshold: 'Sustained, comfortably hard efforts near your threshold pace.',
    intervals: 'Short, fast repeats with full rest between. Builds top-end speed.',
    long:      'Your longest continuous swim of the week. Steady and controlled.',
  };

  const PACE_MULT = {
    recovery: 1.15, technique: 1.20, easy: 1.05,
    threshold: 0.92, intervals: 0.85, long: 1.08,
  };

  // Python weekday() convention (Mon=0 … Sun=6) — see mondayIndex() below.
  const DAY_PATTERNS = {
    2: [1, 4],              // Tue  Fri
    3: [1, 3, 5],           // Tue  Thu  Sat
    4: [0, 2, 4, 5],        // Mon  Wed  Fri  Sat
    5: [0, 1, 3, 4, 6],     // Mon  Tue  Thu  Fri  Sun
    6: [0, 1, 2, 3, 4, 6],  // Mon-Fri + Sun
  };

  const SLOTS = {
    2: [['technique', 0.40], ['long', 0.60]],
    3: [['technique', 0.26], ['threshold', 0.32], ['long', 0.42]],
    4: [['technique', 0.20], ['threshold', 0.26], ['easy', 0.20], ['long', 0.34]],
    5: [['recovery', 0.10], ['technique', 0.18], ['threshold', 0.24], ['easy', 0.16], ['long', 0.32]],
    6: [['recovery', 0.08], ['technique', 0.16], ['intervals', 0.18], ['threshold', 0.20],
        ['easy', 0.10], ['long', 0.28]],
  };

  const DEFAULT_PACE_SEC_PER_100M = 120.0;

  const DEFAULT_WEEKS = 6;
  const MIN_WEEKS     = 1;
  const MAX_WEEKS     = 24;
  const WEEK_CAP      = 1.20;
  const WEEKLY_FLOOR_M   = 1500;
  const DISTANCE_FLOOR_M = 200;

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
  // file and swim_plan_engine.py schedule the same weekdays.
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

  function generateSwimPlan({ goal, level, daysPerWeek, weeklyTargetM, avgPaceSecPer100m, weeks, days }) {
    const [pattern, dpw] = resolveDays(days, daysPerWeek, 2, 6, DAY_PATTERNS);
    daysPerWeek = dpw;
    weeks       = Math.min(Math.max(parseInt(weeks, 10) || DEFAULT_WEEKS, MIN_WEEKS), MAX_WEEKS);
    const slots   = SLOTS[daysPerWeek];
    const factors = weekFactors(weeks, RACE_GOALS.has(goal));

    const levelScale = { beginner: 0.85, intermediate: 1.0, advanced: 1.15 }[level] ?? 1.0;
    const baseWeekly = Math.max(weeklyTargetM * levelScale, WEEKLY_FLOOR_M);
    const pace       = avgPaceSecPer100m > 0 ? avgPaceSecPer100m : DEFAULT_PACE_SEC_PER_100M;

    const entries = [];
    factors.forEach(wf => {
      const weekM = baseWeekly * wf;
      slots.forEach(([stype, weight]) => {
        const distM  = Math.max(Math.round(weekM * weight), DISTANCE_FLOOR_M);
        const durMin = Math.round((distM / 100) * (pace * PACE_MULT[stype]) / 60 * 10) / 10;
        entries.push({
          swim_type:           stype,
          target_distance_m:   distM,
          target_duration_min: durMin,
          description:         DESCRIPTIONS[stype],
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

  function computeSwimAdaptation(swims, planEntries) {
    const today = isoDate(new Date());

    const completedByDate = {};
    swims.forEach(s => {
      const d = String(s.date || '').slice(0, 10);
      if (!d) return;
      completedByDate[d] = (completedByDate[d] || 0) + (s.distance_m || 0);
    });

    const pastPlanned = Object.entries(planEntries)
      .filter(([ds, e]) => ds <= today && (e.target_distance_m || 0) > 0)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 12);

    if (!pastPlanned.length) {
      return { factor: 0, status: 'on_track',
               message: 'Complete your first planned swim to unlock adaptive adjustments.' };
    }

    const scores = pastPlanned.map(([ds, e]) => {
      const target = e.target_distance_m || 1;
      return Math.min((completedByDate[ds] || 0) / target, 1.15);
    });
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const n   = scores.length;
    const pct = (avg * 100).toFixed(0);

    let factor, note;
    if      (avg >= 0.95) { factor = 0.08;  note = `Strong adherence — hitting ${pct}% of planned distance across your last ${n} swims.`; }
    else if (avg >= 0.80) { factor = 0;     note = `Solid consistency (${pct}% of planned distance).`; }
    else if (avg >= 0.60) { factor = -0.08; note = `Hitting ${pct}% of planned distance — upcoming sets eased slightly.`; }
    else                  { factor = -0.15; note = `Hitting ${pct}% of planned distance — significant volume reduction applied.`; }

    const now = Date.now();
    let acute = 0, chronic = 0;
    swims.forEach(s => {
      const d = String(s.date || '').slice(0, 10);
      if (!d) return;
      const dDate = new Date(d + 'T12:00:00');
      if (isNaN(dDate)) return;
      const daysAgo = (now - dDate.getTime()) / 86400000;
      const m = s.distance_m || 0;
      if (daysAgo >= 0 && daysAgo < 7)       acute   += m;
      else if (daysAgo >= 7 && daysAgo < 28) chronic += m;
    });

    const chronicWeekly = chronic / 3;
    if (chronicWeekly >= WEEKLY_FLOOR_M) {
      const ramp = acute / chronicWeekly;
      if (ramp > 1.40) {
        factor -= 0.04;
        note += ` Weekly volume is climbing quickly (${acute.toFixed(0)}m vs a ${chronicWeekly.toFixed(0)}m/week average) — eased back to protect your shoulders.`;
      } else if (ramp < 0.60 && avg >= 0.80) {
        factor += 0.03;
        note += ' Recent volume has been light, so there\'s room to build.';
      }
    }

    const fbNudges = { too_easy: 0.04, just_right: 0.0, too_hard: -0.06 };
    const fbByDate = {};
    swims.forEach(s => {
      const d = String(s.date || '').slice(0, 10);
      if (d && s.feedback) fbByDate[d] = s.feedback;
    });
    const fbValues = pastPlanned.map(([ds]) => fbByDate[ds]).filter(Boolean);
    if (fbValues.length) {
      const fbDelta = fbValues.reduce((a, f) => a + (fbNudges[f] || 0), 0) / fbValues.length;
      if (Math.abs(fbDelta) >= 0.01) {
        factor += fbDelta;
        note += fbDelta > 0
          ? " You've told me recent swims felt easy, so upcoming volume is nudged up a bit more."
          : " You've flagged recent swims as tough, so upcoming volume is eased back further.";
      }
      // Negative feedback always wins over a positive adherence bonus.
      if (fbDelta < 0) factor = Math.min(factor, fbDelta);
    }

    factor = Math.max(-0.15, Math.min(0.10, factor));
    const status = factor > 0.02 ? 'adjusted_up' : factor < -0.02 ? 'adjusted_down' : 'on_track';
    if (status === 'on_track' && !note.endsWith('build.')) note += ' Plan is progressing as intended.';
    return { factor, status, message: note };
  }

  function applySwimAdaptation(entry, factor) {
    if (Math.abs(factor) < 0.005) return entry;
    const e = { ...entry };
    const dist = e.target_distance_m || 0;
    const dur  = e.target_duration_min || 0;
    if (dist > 0) e.target_distance_m   = Math.max(Math.round(dist * (1 + factor)), DISTANCE_FLOOR_M);
    if (dur  > 0) e.target_duration_min = Math.round(dur * (1 + factor) * 10) / 10;
    return e;
  }

  return { generateSwimPlan, computeSwimAdaptation, applySwimAdaptation, weekFactors };
})();
