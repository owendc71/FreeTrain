'use strict';

/* ═══════════════════════════════════════════════════════════════════
   TargetFormat – how prescribed targets are written.

   A plan is a prescription, not a measurement. A coach writes "6-7
   miles", never "7.1 miles". The engines snap targets to a readable
   grid; this brackets that target to the round unit either side, which
   is how a range actually gets written on a training plan.

   The bracket is deliberately never wider than one whole unit, so a
   marathon-length run reads "26 mi", not "24.5-27.5 mi". When the
   target already sits on a round unit the bracket collapses and a
   single number is shown, rather than inventing spurious width.

   Applies to TARGETS only. Completed activity is never bracketed — a
   run that measured 7.1 miles really was 7.1 miles, and rounding a
   fact would be a lie.
═══════════════════════════════════════════════════════════════════ */

const TargetFormat = (() => {

  const MILE_M = 1609.34;
  // Targets are stored as whole metres, so a value snapped to an exact
  // mile arrives as 11265 m = 6.99977 mi. Without a tolerance wider than
  // that ±0.5 m rounding, floor/ceil straddle it and "7 mi" renders as
  // "6-7 mi" — and "1 mi" as "0-1 mi".
  const EPS    = 1e-3;

  // 6 -> "6", 6.5 -> "6.5" (never a trailing ".0")
  const trim = n => Number(n.toFixed(1)).toString();

  /** Bracket a value to the round `unit` either side of it. Returns a
   *  single value when it already sits on one. */
  function bracket(value, unit) {
    const lo = Math.floor(value / unit + EPS) * unit;
    const hi = Math.ceil(value / unit - EPS) * unit;
    return [lo, hi];
  }

  /** Metres -> "6-7 mi", or "7 mi" when the target is already whole. */
  function runDistance(meters, { short = false } = {}) {
    if (!meters) return null;
    const unit = short ? 'mi' : ' mi';
    const [lo, hi] = bracket(meters / MILE_M, 1);
    return lo >= hi ? `${trim(lo)}${unit}` : `${trim(lo)}–${trim(hi)}${unit}`;
  }

  /** Metres -> "2400 m" / "2.4-2.6 km", in the units swimmers write sets in. */
  function swimDistance(meters, { short = false } = {}) {
    if (!meters) return null;

    if (meters < 1000) {
      const [lo, hi] = bracket(meters, 100);
      const u = short ? 'm' : ' m';
      return lo >= hi ? `${Math.round(lo)}${u}` : `${Math.round(lo)}–${Math.round(hi)}${u}`;
    }
    const [lo, hi] = bracket(meters / 1000, 0.5);   // half-kilometre units
    const u = short ? 'km' : ' km';
    return lo >= hi ? `${trim(lo)}${u}` : `${trim(lo)}–${trim(hi)}${u}`;
  }

  /** Durations stay single values: they're already on a 5-minute grid and
   *  "45 min" reads as guidance without needing a bracket. */
  function duration(minutes, { short = false } = {}) {
    if (!minutes) return null;
    const m = Math.round(minutes);
    if (m < 60) return `${m}${short ? 'min' : ' min'}`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  return { runDistance, swimDistance, duration };
})();

window.TargetFormat = TargetFormat;
