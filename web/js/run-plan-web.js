'use strict';

/* ═══════════════════════════════════════════════════════════════════
   RunPlanWebEngine – JS port of server/run_plan_engine.py.
   Pure computation, no server needed.
═══════════════════════════════════════════════════════════════════ */

const RunPlanWebEngine = (() => {

  const RACE_GOALS = new Set(['five_k', 'ten_k', 'half_marathon', 'marathon']);

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

  const WEEK_FACTORS_BUILD = [0.85, 0.95, 1.00, 0.70, 1.00, 1.05];
  const WEEK_FACTORS_RACE  = [0.85, 0.95, 1.00, 0.70, 1.00, 0.70];

  const DEFAULT_PACE_SEC_PER_KM = 375.0;

  function nextMonday(d) {
    const r = new Date(d);
    const delta = (7 - r.getDay()) % 7;
    r.setDate(r.getDate() + delta);
    return r;
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function generateRunPlan({ goal, level, daysPerWeek, weeklyTargetM, avgPaceSecPerKm }) {
    daysPerWeek = Math.min(Math.max(daysPerWeek, 3), 6);
    const slots   = SLOTS[daysPerWeek];
    const factors = RACE_GOALS.has(goal) ? WEEK_FACTORS_RACE : WEEK_FACTORS_BUILD;

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

    const pattern = DAY_PATTERNS[daysPerWeek];
    const dates   = [];
    let cursor    = nextMonday(new Date());
    while (dates.length < entries.length) {
      if (pattern.includes(cursor.getDay())) dates.push(isoDate(cursor));
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
