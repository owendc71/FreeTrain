"""
FreeTrain adaptive swimming plan engine.

Generates periodized swim plans of any length (1-24 weeks) and adapts
upcoming planned distances based on adherence, weekly load ramp, and the
athlete's own post-swim feedback.

Mirrors run_plan_engine.py — swimming is the same shape of problem
(distance + pace, no live-executed workout), with pace measured in
seconds per 100m, the standard swim unit.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from run_plan_engine import (
    DURATION_STEP_MIN, resolve_days, round_half_up, snap_swim_step, snap_to,
)

# Goals that finish with a taper rather than a peak week.
_RACE_GOALS = {"distance_event", "race_prep", "triathlon"}

_DESCRIPTIONS = {
    "recovery":  "Easy loosener. Long, relaxed strokes — should feel almost too easy.",
    "technique": "Drill-focused set. Prioritise stroke quality over speed or effort.",
    "easy":      "Steady aerobic swimming at a conversational effort.",
    "threshold": "Sustained, comfortably hard efforts near your threshold pace.",
    "intervals": "Short, fast repeats with full rest between. Builds top-end speed.",
    "long":      "Your longest continuous swim of the week. Steady and controlled.",
}

# Pace multiplier applied to the swimmer's average easy pace (sec/100m).
# < 1.0 = faster than average, > 1.0 = easier.
_PACE_MULT = {
    "recovery":  1.15,
    "technique": 1.20,   # drills are slow by design
    "easy":      1.05,
    "threshold": 0.92,
    "intervals": 0.85,
    "long":      1.08,
}

# Training day patterns by days-per-week (0=Mon … 6=Sun)
_DAY_PATTERNS: dict[int, list[int]] = {
    2: [1, 4],              # Tue  Fri
    3: [1, 3, 5],           # Tue  Thu  Sat
    4: [0, 2, 4, 5],        # Mon  Wed  Fri  Sat
    5: [0, 1, 3, 4, 6],     # Mon  Tue  Thu  Fri  Sun
    6: [0, 1, 2, 3, 4, 6],  # Mon-Fri + Sun
}

# Per-slot (type, share of weekly metres) — shares sum to 1.0 per week.
# The long swim always lands on the last scheduled day of the week.
_SLOTS: dict[int, list[tuple[str, float]]] = {
    2: [("technique", 0.40), ("long", 0.60)],
    3: [("technique", 0.26), ("threshold", 0.32), ("long", 0.42)],
    4: [("technique", 0.20), ("threshold", 0.26), ("easy", 0.20), ("long", 0.34)],
    5: [("recovery", 0.10), ("technique", 0.18), ("threshold", 0.24), ("easy", 0.16),
        ("long", 0.32)],
    6: [("recovery", 0.08), ("technique", 0.16), ("intervals", 0.18), ("threshold", 0.20),
        ("easy", 0.10), ("long", 0.28)],
}

DEFAULT_PACE_SEC_PER_100M = 120.0   # ~2:00/100m, a common recreational easy pace

# Plan length
DEFAULT_WEEKS = 6
MIN_WEEKS     = 1
MAX_WEEKS     = 24

_WEEK_CAP    = 1.20     # never exceed 120% of target weekly volume
_WEEKLY_FLOOR_M = 1500  # a plan below ~1.5km/week isn't worth periodizing
_DISTANCE_FLOOR_M = 200 # never schedule a swim shorter than 200m


def week_factors(weeks: int, taper: bool) -> list[float]:
    """
    3:1 periodization of arbitrary length, as a fraction of target weekly
    volume: three progressively harder weeks, then a recovery week at
    70%, repeating — each 4-week block starting 15% higher than the last,
    capped at 120%. Race goals replace the final week with a taper.

    Identical to run_plan_engine.week_factors(); kept per-discipline so
    each engine stays independently tunable.
    """
    out: list[float] = []
    for i in range(weeks):
        if i % 4 == 3:
            out.append(0.70)
        else:
            block = i // 4
            out.append(round(min([0.85, 0.95, 1.00][i % 4] + 0.15 * block, _WEEK_CAP), 2))
    if taper and weeks >= 2:
        out[-1] = 0.70
    return out


# ── Public API ──────────────────────────────────────────────────────

def generate_swim_plan(
    goal: str,
    level: str,
    days_per_week: int,
    weekly_target_m: float,
    avg_pace_sec_per_100m: float = DEFAULT_PACE_SEC_PER_100M,
    weeks: int = DEFAULT_WEEKS,
    start_date: Optional[date] = None,
    days: Optional[list[int]] = None,
) -> list[tuple[str, dict]]:
    """Return [(date_iso, entry_dict), …] for a `weeks`-long swim plan."""
    pattern, days_per_week = resolve_days(days, days_per_week, 2, 6, _DAY_PATTERNS)
    weeks   = max(MIN_WEEKS, min(int(weeks or DEFAULT_WEEKS), MAX_WEEKS))
    slots   = _SLOTS[days_per_week]
    factors = week_factors(weeks, taper=goal in _RACE_GOALS)

    level_scale = {"beginner": 0.85, "intermediate": 1.0, "advanced": 1.15}.get(level, 1.0)
    base_weekly = max(weekly_target_m * level_scale, _WEEKLY_FLOOR_M)
    pace        = avg_pace_sec_per_100m if avg_pace_sec_per_100m > 0 else DEFAULT_PACE_SEC_PER_100M

    entries: list[dict] = []
    for wf in factors:
        week_m = base_weekly * wf
        for stype, weight in slots:
            raw_m   = max(week_m * weight, _DISTANCE_FLOOR_M)
            dist_m  = round_half_up(snap_to(raw_m, snap_swim_step(raw_m), _DISTANCE_FLOOR_M))
            raw_min = (dist_m / 100) * (pace * _PACE_MULT[stype]) / 60
            dur_min = snap_to(raw_min, DURATION_STEP_MIN, DURATION_STEP_MIN)
            entries.append({
                "swim_type":           stype,
                "target_distance_m":   dist_m,
                "target_duration_min": dur_min,
                "description":         _DESCRIPTIONS[stype],
            })

    from_date  = start_date or date.today()
    days_ahead = (7 - from_date.weekday()) % 7
    start      = from_date + timedelta(days=days_ahead)

    dates: list[date] = []
    cursor = start
    while len(dates) < len(entries):
        if cursor.weekday() in pattern:
            dates.append(cursor)
        cursor += timedelta(days=1)

    return [(d.isoformat(), e) for d, e in zip(dates, entries)]


def compute_swim_adaptation(swims: list[dict], plan_entries: dict[str, dict]) -> tuple[float, str, str]:
    """
    Three signals, mirroring compute_run_adaptation():
      1. Adherence — did the swimmer hit planned distance on planned days
         over the last ~12 planned sessions?
      2. Load ramp — metres in the last 7 days vs. the weekly average of
         the previous 3 weeks. Swimming is far lower-impact than running,
         so the ramp penalty here is gentler (shoulder overuse is the
         real risk, not bone/tendon load).
      3. Subjective feedback — the athlete's own "too easy / just right /
         too hard" rating from the coach chat's post-swim check-in.

    Returns (factor, status, message) with factor in -0.15 … +0.10.
    """
    def _sdate(s) -> Optional[date]:
        try:
            return date.fromisoformat(str(s.get("date", ""))[:10])
        except ValueError:
            return None

    today = date.today()
    completed_by_date: dict[str, float] = {}
    for s in swims:
        d = _sdate(s)
        if d:
            key = d.isoformat()
            completed_by_date[key] = completed_by_date.get(key, 0) + (s.get("distance_m") or 0)

    past_planned = [
        (ds, e) for ds, e in plan_entries.items()
        if ds <= today.isoformat() and (e.get("target_distance_m") or 0) > 0
    ]
    past_planned.sort(key=lambda x: x[0], reverse=True)
    recent = past_planned[:12]

    if not recent:
        return 0.0, "on_track", "Complete your first planned swim to unlock adaptive adjustments."

    scores = []
    for ds, e in recent:
        target = e.get("target_distance_m") or 1
        actual = completed_by_date.get(ds, 0)
        scores.append(min(actual / target, 1.15))

    avg = sum(scores) / len(scores)
    n   = len(scores)

    if avg >= 0.95:
        factor, note = 0.08, f"Strong adherence — hitting {avg*100:.0f}% of planned distance across your last {n} swims."
    elif avg >= 0.80:
        factor, note = 0.0, f"Solid consistency ({avg*100:.0f}% of planned distance)."
    elif avg >= 0.60:
        factor, note = -0.08, f"Hitting {avg*100:.0f}% of planned distance — upcoming sets eased slightly."
    else:
        factor, note = -0.15, f"Hitting {avg*100:.0f}% of planned distance — significant volume reduction applied."

    # ── Load ramp ────────────────────────────────────────────────────
    acute = chronic = 0.0
    for s in swims:
        d = _sdate(s)
        if d is None:
            continue
        days_ago = (today - d).days
        m = s.get("distance_m") or 0
        if 0 <= days_ago < 7:
            acute += m
        elif 7 <= days_ago < 28:
            chronic += m

    chronic_weekly = chronic / 3
    if chronic_weekly >= _WEEKLY_FLOOR_M:
        ramp = acute / chronic_weekly
        if ramp > 1.40:      # more headroom than running — lower impact
            factor -= 0.04
            note += (f" Weekly volume is climbing quickly ({acute:.0f}m vs a "
                     f"{chronic_weekly:.0f}m/week average) — eased back to protect your shoulders.")
        elif ramp < 0.60 and avg >= 0.80:
            factor += 0.03
            note += " Recent volume has been light, so there's room to build."

    # ── Subjective feedback nudge ────────────────────────────────────
    fb_nudges = {"too_easy": 0.04, "just_right": 0.0, "too_hard": -0.06}
    fb_by_date: dict[str, str] = {}
    for s in swims:
        d = _sdate(s)
        if d and s.get("feedback"):
            fb_by_date[d.isoformat()] = s["feedback"]
    fb_values = [fb_by_date[ds] for ds, _ in recent if ds in fb_by_date]
    if fb_values:
        fb_delta = sum(fb_nudges.get(f, 0.0) for f in fb_values) / len(fb_values)
        if abs(fb_delta) >= 0.01:
            factor += fb_delta
            note += (" You've told me recent swims felt easy, so upcoming volume is nudged up a bit more."
                      if fb_delta > 0 else
                      " You've flagged recent swims as tough, so upcoming volume is eased back further.")
        # Hitting every target doesn't justify more volume when the athlete
        # is telling us it's too hard — negative feedback always wins over
        # a positive adherence bonus.
        if fb_delta < 0:
            factor = min(factor, fb_delta)

    factor = max(-0.15, min(0.10, factor))
    status = ("adjusted_up" if factor > 0.02
              else "adjusted_down" if factor < -0.02
              else "on_track")
    if status == "on_track" and not note.endswith("build."):
        note += " Plan is progressing as intended."
    return factor, status, note


def apply_swim_adaptation(entry: dict, factor: float) -> dict:
    """Return a copy of entry with target distance/duration scaled by (1 + factor)."""
    if abs(factor) < 0.005:
        return entry

    e = dict(entry)
    dist = e.get("target_distance_m") or 0
    dur  = e.get("target_duration_min") or 0
    if dist > 0:
        scaled = dist * (1 + factor)
        e["target_distance_m"] = round_half_up(snap_to(scaled, snap_swim_step(scaled), _DISTANCE_FLOOR_M))
    if dur > 0:
        e["target_duration_min"] = snap_to(dur * (1 + factor), DURATION_STEP_MIN, DURATION_STEP_MIN)
    return e
