'use strict';

/* ═══════════════════════════════════════════════════════════════════
   PlanWebEngine – JS port of server/plan_engine.py.
   Pure computation, no server needed.
═══════════════════════════════════════════════════════════════════ */

const PlanWebEngine = (() => {

  // ── Interval primitives ─────────────────────────────────────────
  // power_pct is a fraction of FTP (0.65 = 65%) to match user-created
  // workouts, the chart, and the workout engine.
  const iv = (dur, pct, label) => ({ duration: dur * 60, power_pct: pct / 100, label, name: label });
  const wu  = (d = 10) => iv(d,  60, 'Warm-up');
  const cd  = (d =  5) => iv(d,  55, 'Cool-down');
  const z2  = d        => iv(d,  65, 'Endurance');
  const ss  = d        => iv(d,  88, 'Sweet Spot');
  const thr = d        => iv(d,  97, 'Threshold');
  const vo2 = d        => iv(d, 115, 'VO2 Max');
  const rst = (d = 2)  => iv(d,  50, 'Rest');

  function interleave(parts, restMin) {
    return parts.flatMap((p, i) => i < parts.length - 1 ? [p, rst(restMin)] : [p]);
  }

  // ── Workout factories ─────────────────────────────────────────────
  const TAG = 'FreeTrain · ';

  function wRecovery(mins = 35) {
    mins = Math.max(mins, 25);
    return { name: `${TAG}Recovery`, description: 'Easy spinning to flush fatigue.',
             intervals: [wu(10), z2(mins - 15), cd(5)] };
  }

  function wEndurance(mins = 60) {
    return { name: `${TAG}Endurance ${mins}min`,
             description: 'Steady Zone 2 aerobic work. Conversational effort.',
             intervals: [wu(10), z2(Math.max(mins - 15, 10)), cd(5)] };
  }

  function wSweetspot(reps, repMin, total = 60) {
    const parts  = Array.from({ length: reps }, () => ss(repMin));
    const main   = interleave(parts, 2);
    const work   = repMin * reps + 2 * (reps - 1);
    const filler = Math.max(total - 15 - work, 0);
    const ivs    = [wu(10)];
    if (filler > 4) ivs.push(z2(Math.floor(filler / 2)));
    ivs.push(...main);
    if (filler > 4) ivs.push(z2(filler - Math.floor(filler / 2)));
    ivs.push(cd(5));
    return { name: `${TAG}Sweet Spot ${reps}×${repMin}min`,
             description: `${reps}×${repMin}min at 88-93% FTP.`, intervals: ivs };
  }

  function wThreshold(reps, repMin, total = 60) {
    const parts  = Array.from({ length: reps }, () => thr(repMin));
    const main   = interleave(parts, 3);
    const work   = repMin * reps + 3 * (reps - 1);
    const filler = Math.max(total - 15 - work, 0);
    const ivs    = [wu(10)];
    if (filler > 0) ivs.push(z2(filler));
    ivs.push(...main, cd(5));
    return { name: `${TAG}Threshold ${reps}×${repMin}min`,
             description: `${reps}×${repMin}min at 95-100% FTP.`, intervals: ivs };
  }

  function wVO2(reps, repMin, total = 60) {
    const parts  = Array.from({ length: reps }, () => vo2(repMin));
    const main   = interleave(parts, repMin);
    const work   = repMin * 2 * reps - repMin;
    const filler = Math.max(total - 20 - work, 0);
    const ivs    = [wu(15)];
    if (filler > 0) ivs.push(z2(filler));
    ivs.push(...main, cd(5));
    return { name: `${TAG}VO2 Max ${reps}×${repMin}min`,
             description: `${reps}×${repMin}min at 115%+ FTP.`, intervals: ivs };
  }

  // ── Session-type library ──────────────────────────────────────────
  const FIXED = {
    'recovery':       () => wRecovery(35),
    'sweetspot_easy': () => wSweetspot(1, 10, 45),
    'sweetspot_1x15': () => wSweetspot(1, 15, 50),
    'sweetspot_2x12': () => wSweetspot(2, 12, 55),
    'sweetspot_2x15': () => wSweetspot(2, 15, 60),
    'sweetspot_3x12': () => wSweetspot(3, 12, 65),
    'sweetspot_3x15': () => wSweetspot(3, 15, 75),
    'threshold_1x8':  () => wThreshold(1,  8, 45),
    'threshold_2x8':  () => wThreshold(2,  8, 55),
    'threshold_2x10': () => wThreshold(2, 10, 60),
    'threshold_3x8':  () => wThreshold(3,  8, 65),
    'vo2_4x3':        () => wVO2(4, 3, 55),
    'vo2_5x3':        () => wVO2(5, 3, 60),
    'vo2_5x4':        () => wVO2(5, 4, 70),
  };
  const VARIABLE = {
    'endurance_easy': m => wEndurance(Math.max(Math.round(m * 0.75), 30)),
    'endurance':      m => wEndurance(m),
    'endurance_long': m => wEndurance(Math.round(m * 1.35)),
    'endurance_xl':   m => wEndurance(Math.round(m * 1.65)),
  };

  function buildSession(type, baseMins) {
    if (FIXED[type])    return FIXED[type]();
    if (VARIABLE[type]) return VARIABLE[type](baseMins);
    return wEndurance(baseMins);
  }

  // ── 6-week plan templates (same as plan_engine.py) ───────────────
  const PLANS = {
    base_fitness: {
      3: ['endurance','sweetspot_easy','endurance_long','endurance','sweetspot_1x15','endurance_long','endurance','sweetspot_2x12','endurance_long','recovery','endurance_easy','recovery','endurance','sweetspot_2x15','endurance_long','endurance','threshold_1x8','endurance_xl'],
      4: ['endurance','sweetspot_easy','recovery','endurance_long','endurance','sweetspot_1x15','recovery','endurance_long','endurance','sweetspot_2x12','recovery','endurance_long','recovery','endurance_easy','recovery','endurance_easy','endurance','sweetspot_2x15','recovery','endurance_long','endurance','threshold_1x8','recovery','endurance_xl'],
      5: ['endurance','sweetspot_easy','recovery','sweetspot_easy','endurance_long','endurance','sweetspot_1x15','recovery','sweetspot_easy','endurance_long','endurance','sweetspot_2x12','recovery','sweetspot_1x15','endurance_long','recovery','endurance_easy','recovery','endurance_easy','recovery','endurance','sweetspot_2x15','recovery','sweetspot_2x12','endurance_long','endurance','threshold_1x8','recovery','sweetspot_2x15','endurance_xl'],
    },
    build_fitness: {
      3: ['endurance','sweetspot_2x12','endurance_long','sweetspot_2x15','threshold_1x8','endurance_long','sweetspot_3x12','threshold_2x8','endurance_long','recovery','endurance_easy','recovery','sweetspot_3x12','threshold_2x10','endurance_long','threshold_2x10','vo2_4x3','endurance_xl'],
      4: ['endurance','sweetspot_2x12','recovery','endurance_long','sweetspot_2x12','threshold_1x8','recovery','endurance_long','sweetspot_2x15','threshold_2x8','recovery','endurance_long','recovery','endurance_easy','recovery','endurance_easy','sweetspot_3x12','threshold_2x8','recovery','endurance_long','threshold_2x10','vo2_4x3','recovery','endurance_xl'],
      5: ['endurance','sweetspot_2x12','recovery','threshold_1x8','endurance_long','sweetspot_2x12','threshold_1x8','recovery','sweetspot_2x12','endurance_long','sweetspot_2x15','threshold_2x8','recovery','sweetspot_2x15','endurance_long','recovery','endurance_easy','recovery','endurance_easy','recovery','sweetspot_3x12','threshold_2x8','recovery','threshold_1x8','endurance_long','threshold_2x10','vo2_4x3','recovery','sweetspot_3x12','endurance_xl'],
    },
    century: {
      3: ['endurance','sweetspot_easy','endurance_long','endurance_long','sweetspot_1x15','endurance_xl','endurance_long','sweetspot_2x12','endurance_xl','recovery','endurance_easy','recovery','endurance_long','sweetspot_2x12','endurance_xl','endurance_long','sweetspot_2x15','endurance_xl'],
      4: ['endurance','sweetspot_easy','recovery','endurance_long','endurance_long','sweetspot_1x15','recovery','endurance_xl','endurance_long','sweetspot_2x12','recovery','endurance_xl','recovery','endurance_easy','recovery','endurance','endurance_long','sweetspot_2x12','recovery','endurance_xl','endurance_long','sweetspot_2x15','recovery','endurance_xl'],
      5: ['endurance','sweetspot_easy','recovery','endurance','endurance_long','endurance_long','sweetspot_1x15','recovery','endurance','endurance_xl','endurance_long','sweetspot_2x12','recovery','sweetspot_easy','endurance_xl','recovery','endurance_easy','recovery','endurance_easy','recovery','endurance_long','sweetspot_2x12','recovery','sweetspot_1x15','endurance_xl','endurance_long','sweetspot_2x15','recovery','sweetspot_2x12','endurance_xl'],
    },
    race_prep: {
      3: ['endurance','sweetspot_2x12','endurance_long','sweetspot_2x15','threshold_2x8','endurance_long','sweetspot_3x12','threshold_2x10','endurance_long','recovery','endurance_easy','recovery','threshold_2x10','vo2_4x3','endurance_long','threshold_3x8','vo2_5x3','endurance'],
      4: ['endurance','sweetspot_2x12','recovery','endurance_long','sweetspot_2x15','threshold_1x8','recovery','endurance_long','sweetspot_3x12','threshold_2x8','recovery','endurance_long','recovery','endurance_easy','recovery','endurance_easy','threshold_2x10','vo2_4x3','recovery','endurance_long','threshold_3x8','vo2_5x3','recovery','endurance'],
      5: ['endurance','sweetspot_2x12','recovery','threshold_1x8','endurance_long','sweetspot_2x15','threshold_2x8','recovery','sweetspot_2x12','endurance_long','sweetspot_3x12','threshold_2x10','recovery','threshold_2x8','endurance_long','recovery','endurance_easy','recovery','endurance_easy','recovery','threshold_2x10','vo2_4x3','recovery','threshold_2x8','endurance_long','threshold_3x8','vo2_5x4','recovery','sweetspot_3x12','endurance'],
    },
  };

  const DAY_PATTERNS = {
    3: [1, 3, 5],
    4: [1, 3, 5, 6],
    5: [0, 1, 3, 5, 6],
    6: [0, 1, 2, 4, 5, 6],
    7: [0, 1, 2, 3, 4, 5, 6],
  };

  function nextMonday(d) {
    const r = new Date(d);
    const delta = (7 - r.getDay()) % 7;
    r.setDate(r.getDate() + delta);
    return r;
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // ── Public API ────────────────────────────────────────────────────

  function generatePlan({ goal, level, daysPerWeek, sessionMins }) {
    goal        = PLANS[goal] ? goal : 'base_fitness';
    daysPerWeek = Math.min(Math.max(daysPerWeek, 3), 7);

    const scale   = { beginner: 0.85, intermediate: 1.0, advanced: 1.15 }[level] ?? 1.0;
    const effMins = Math.max(Math.round(sessionMins * scale), 30);

    let types = [...(PLANS[goal][Math.min(daysPerWeek, 5)] || PLANS[goal][4])];
    if (daysPerWeek > 5) {
      const extra = daysPerWeek - 5;
      const expanded = [];
      for (let w = 0; w < 6; w++) {
        const week = types.slice(w * 5, (w + 1) * 5);
        const adds = (w % 4 === 3) ? Array(extra).fill('recovery') : Array(extra).fill('endurance_easy');
        expanded.push(...adds, ...week);
      }
      types = expanded;
    }

    const pattern = DAY_PATTERNS[daysPerWeek];
    const dates   = [];
    let cursor    = nextMonday(new Date());
    while (dates.length < types.length) {
      if (pattern.includes(cursor.getDay())) dates.push(isoDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    return types.map((type, i) => ({ date: dates[i], workout: buildSession(type, effMins) }));
  }

  function computeAdaptation(rides) {
    const recent = rides.filter(r => r.completed).slice(0, 5);
    if (!recent.length) return { factor: 0, status: 'on_track', message: 'Complete your first workout to unlock adaptive adjustments.' };

    const scores = recent.map(r => {
      const total      = r.total_duration || 1;
      const completion = Math.min(r.elapsed / total, 1.05);
      const ifRatio    = Math.min((r.intensity_factor || 0.75) / 0.75, 1.15);
      return completion * 0.65 + ifRatio * 0.35;
    });
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const n   = scores.length;

    if (avg >= 0.95) return { factor: 0.08, status: 'adjusted_up',   message: `You're nailing it — ${(avg*100).toFixed(0)}% adherence across your last ${n} rides. Next sessions bumped up.` };
    if (avg >= 0.82) return { factor: 0,    status: 'on_track',      message: `Solid consistency (${(avg*100).toFixed(0)}% adherence). Plan progressing as intended.` };
    if (avg >= 0.65) return { factor:-0.08, status: 'adjusted_down', message: `Adherence at ${(avg*100).toFixed(0)}% — upcoming sessions eased slightly.` };
    return              { factor:-0.15, status: 'adjusted_down', message: `Adherence at ${(avg*100).toFixed(0)}% — significant load reduction applied.` };
  }

  function applyAdaptation(workout, factor) {
    if (Math.abs(factor) < 0.005) return workout;
    const SKIP = new Set(['Warm-up','Cool-down','Rest','Rest Interval','Recovery']);
    return {
      ...workout,
      intervals: workout.intervals.map(iv => ({
        ...iv,
        power_pct: SKIP.has(iv.label)
          ? iv.power_pct
          : Math.max(0.40, Math.round(iv.power_pct * (1 + factor) * 1000) / 1000),
      })),
    };
  }

  return { generatePlan, computeAdaptation, applyAdaptation };
})();
