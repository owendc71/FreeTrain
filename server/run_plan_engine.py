"""
FreeTrain adaptive running plan engine.

Generates periodized 6-week mileage plans and adapts upcoming planned
distances based on adherence and weekly load ramp — mirrors
plan_engine.py's approach for cycling, but targets distance instead of
power since there's no live-executed running workout.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

_RACE_GOALS = {"five_k", "ten_k", "half_marathon", "marathon"}

_DESCRIPTIONS = {
    "recovery":  "Very easy shakeout run. Effort should feel almost too easy.",
    "easy":      "Conversational effort. Builds aerobic base without added fatigue.",
    "tempo":     "Comfortably hard, sustained effort — 'controlled discomfort.'",
    "intervals": "Faster intervals with recovery jogs between. Raises top-end speed.",
    "long":      "Your longest run of the week. Steady, easy-to-moderate effort.",
}

# Pace multiplier applied to the runner's average easy pace (sec/km).
# < 1.0 = faster than average pace, > 1.0 = slower / easier.
_PACE_MULT = {"recovery": 1.15, "easy": 1.05, "tempo": 0.92, "intervals": 0.85, "long": 1.08}

# Training day patterns by days-per-week (weekday numbers: 0=Mon … 6=Sun)
_DAY_PATTERNS: dict[int, list[int]] = {
    3: [1, 3, 5],           # Tue  Thu  Sat
    4: [1, 3, 5, 6],        # Tue  Thu  Sat  Sun
    5: [0, 1, 3, 5, 6],     # Mon  Tue  Thu  Sat  Sun
    6: [0, 1, 2, 4, 5, 6],  # Mon  Tue  Wed  Fri  Sat  Sun
}

# Per-slot (type, share of weekly mileage) — shares sum to 1.0 per week.
# The long run always lands on the last scheduled day (Sat/Sun).
_SLOTS: dict[int, list[tuple[str, float]]] = {
    3: [("easy", 0.28), ("tempo", 0.30), ("long", 0.42)],
    4: [("easy", 0.20), ("tempo", 0.26), ("long", 0.40), ("recovery", 0.14)],
    5: [("recovery", 0.10), ("easy", 0.18), ("intervals", 0.22), ("long", 0.38), ("easy", 0.12)],
    6: [("recovery", 0.08), ("easy", 0.16), ("intervals", 0.18), ("tempo", 0.18),
        ("long", 0.32), ("easy", 0.08)],
}

# 3:1 periodization across 6 weeks, as a fraction of the target weekly mileage.
_WEEK_FACTORS_BUILD = [0.85, 0.95, 1.00, 0.70, 1.00, 1.05]   # base_mileage: peak finish
_WEEK_FACTORS_RACE  = [0.85, 0.95, 1.00, 0.70, 1.00, 0.70]   # race goals: taper finish

DEFAULT_PACE_SEC_PER_KM = 375.0   # ~6:15/km, a common recreational easy pace


# ── Public API ──────────────────────────────────────────────────────

def generate_run_plan(
    goal: str,
    level: str,
    days_per_week: int,
    weekly_target_m: float,
    avg_pace_sec_per_km: float = DEFAULT_PACE_SEC_PER_KM,
    start_date: Optional[date] = None,
) -> list[tuple[str, dict]]:
    """Return [(date_iso, entry_dict), …] for a 6-week run plan."""
    days_per_week = max(3, min(days_per_week, 6))
    slots   = _SLOTS[days_per_week]
    factors = _WEEK_FACTORS_RACE if goal in _RACE_GOALS else _WEEK_FACTORS_BUILD

    level_scale = {"beginner": 0.90, "intermediate": 1.0, "advanced": 1.10}.get(level, 1.0)
    base_weekly = max(weekly_target_m * level_scale, 8000)   # floor ~5mi/week
    pace        = avg_pace_sec_per_km if avg_pace_sec_per_km > 0 else DEFAULT_PACE_SEC_PER_KM

    entries: list[dict] = []
    for wf in factors:
        week_m = base_weekly * wf
        for rtype, weight in slots:
            dist_m  = round(week_m * weight)
            dur_min = round((dist_m / 1000) * (pace * _PACE_MULT[rtype]) / 60, 1)
            entries.append({
                "run_type":            rtype,
                "target_distance_m":   dist_m,
                "target_duration_min": dur_min,
                "description":         _DESCRIPTIONS[rtype],
            })

    from_date  = start_date or date.today()
    days_ahead = (7 - from_date.weekday()) % 7
    start      = from_date + timedelta(days=days_ahead)

    pattern = _DAY_PATTERNS[days_per_week]
    dates: list[date] = []
    cursor = start
    while len(dates) < len(entries):
        if cursor.weekday() in pattern:
            dates.append(cursor)
        cursor += timedelta(days=1)

    return [(d.isoformat(), e) for d, e in zip(dates, entries)]


def compute_run_adaptation(runs: list[dict], plan_entries: dict[str, dict]) -> tuple[float, str, str]:
    """
    Two signals, mirroring compute_adaptation() for cycling:
      1. Adherence — did the runner hit their planned distance on planned
         days over the last ~12 planned days?
      2. Load ramp — total mileage the last 7 days vs. the weekly average
         of the previous 3 weeks. Too fast a ramp is the #1 driver of
         running injury, so it's weighted even more heavily than on the
         bike side.

    Returns:
        factor  – target-distance/duration multiplier (-0.15 … +0.10)
        status  – "on_track" | "adjusted_up" | "adjusted_down"
        message – human-readable summary
    """
    def _rdate(r) -> Optional[date]:
        try:
            return date.fromisoformat(str(r.get("date", ""))[:10])
        except ValueError:
            return None

    today = date.today()
    completed_by_date: dict[str, float] = {}
    for r in runs:
        d = _rdate(r)
        if d:
            key = d.isoformat()
            completed_by_date[key] = completed_by_date.get(key, 0) + (r.get("distance_m") or 0)

    past_planned = [
        (ds, e) for ds, e in plan_entries.items()
        if ds <= today.isoformat() and (e.get("target_distance_m") or 0) > 0
    ]
    past_planned.sort(key=lambda x: x[0], reverse=True)
    recent = past_planned[:12]

    if not recent:
        return 0.0, "on_track", "Complete your first planned run to unlock adaptive adjustments."

    scores = []
    for ds, e in recent:
        target = e.get("target_distance_m") or 1
        actual = completed_by_date.get(ds, 0)
        scores.append(min(actual / target, 1.15))

    avg = sum(scores) / len(scores)
    n   = len(scores)

    if avg >= 0.95:
        factor, note = 0.08, f"Strong adherence — hitting {avg*100:.0f}% of planned mileage across your last {n} runs."
    elif avg >= 0.80:
        factor, note = 0.0, f"Solid consistency ({avg*100:.0f}% of planned mileage)."
    elif avg >= 0.60:
        factor, note = -0.08, f"Hitting {avg*100:.0f}% of planned mileage — upcoming distances eased slightly."
    else:
        factor, note = -0.15, f"Hitting {avg*100:.0f}% of planned mileage — significant volume reduction applied."

    # ── Load ramp: injury-risk signal, all runs including Strava imports ──
    acute = chronic = 0.0
    for r in runs:
        d = _rdate(r)
        if d is None:
            continue
        days_ago = (today - d).days
        m = r.get("distance_m") or 0
        if 0 <= days_ago < 7:
            acute += m
        elif 7 <= days_ago < 28:
            chronic += m

    chronic_weekly = chronic / 3
    if chronic_weekly >= 8000:   # need ~5mi/week of history for the ramp to mean anything
        ramp = acute / chronic_weekly
        if ramp > 1.30:
            factor -= 0.06
            note += (f" Weekly mileage is ramping fast ({acute/1000:.1f}km vs a "
                     f"{chronic_weekly/1000:.1f}km/week average) — volume pulled back to protect against injury.")
        elif ramp < 0.60 and avg >= 0.80:
            factor += 0.03
            note += " Recent mileage has been light, so there's room to build."

    factor = max(-0.15, min(0.10, factor))
    status = ("adjusted_up" if factor > 0.02
              else "adjusted_down" if factor < -0.02
              else "on_track")
    if status == "on_track" and not note.endswith("build."):
        note += " Plan is progressing as intended."
    return factor, status, note


def apply_run_adaptation(entry: dict, factor: float) -> dict:
    """Return a copy of entry with target distance/duration scaled by (1 + factor)."""
    if abs(factor) < 0.005:
        return entry

    e = dict(entry)
    dist = e.get("target_distance_m") or 0
    dur  = e.get("target_duration_min") or 0
    if dist > 0:
        e["target_distance_m"] = max(round(dist * (1 + factor)), 800)   # floor ~0.5mi
    if dur > 0:
        e["target_duration_min"] = round(dur * (1 + factor), 1)
    return e
