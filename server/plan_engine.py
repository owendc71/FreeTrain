"""
FreeTrain adaptive training plan engine.

Generates periodized 6-week plans and adapts upcoming workout
intensities based on ride adherence.
"""

from __future__ import annotations

import copy
from datetime import date, timedelta
from typing import Optional


# ── Low-level interval primitives ─────────────────────────────────────

def _iv(dur_min: int, pct: int, label: str) -> dict:
    # power_pct is stored as a fraction of FTP (0.65 = 65%) to match
    # user-created workouts, the chart, and the workout engine.
    return {"duration": dur_min * 60, "power_pct": pct / 100, "label": label, "name": label}

def _wu(d: int = 10) -> dict: return _iv(d,  60, "Warm-up")
def _cd(d: int =  5) -> dict: return _iv(d,  55, "Cool-down")
def _z2(d: int)      -> dict: return _iv(d,  65, "Endurance")
def _ss(d: int)      -> dict: return _iv(d,  88, "Sweet Spot")
def _thr(d: int)     -> dict: return _iv(d,  97, "Threshold")
def _vo2(d: int)     -> dict: return _iv(d, 115, "VO2 Max")
def _rst(d: int = 2) -> dict: return _iv(d,  50, "Rest")


def _interleave(parts: list[dict], rest_min: int) -> list[dict]:
    out: list[dict] = []
    for i, p in enumerate(parts):
        out.append(p)
        if i < len(parts) - 1:
            out.append(_rst(rest_min))
    return out


# ── Workout factories ──────────────────────────────────────────────────

_TAG = "FreeTrain · "


def w_recovery(mins: int = 35) -> dict:
    mins = max(mins, 25)
    return {
        "name": f"{_TAG}Recovery",
        "description": "Easy spinning to flush fatigue. Stay well below threshold.",
        "intervals": [_wu(10), _z2(mins - 15), _cd(5)],
    }


def w_endurance(mins: int = 60) -> dict:
    main = max(mins - 15, 10)
    return {
        "name": f"{_TAG}Endurance {mins}min",
        "description": "Steady Zone 2 aerobic work. Conversational effort throughout.",
        "intervals": [_wu(10), _z2(main), _cd(5)],
    }


def w_sweetspot(reps: int, rep_min: int, total_mins: int = 60) -> dict:
    parts   = [_ss(rep_min) for _ in range(reps)]
    main    = _interleave(parts, 2)
    work    = rep_min * reps + 2 * (reps - 1)
    filler  = max(total_mins - 15 - work, 0)
    ivs     = [_wu(10)]
    if filler > 4:
        ivs.append(_z2(filler // 2))
    ivs.extend(main)
    if filler > 4:
        ivs.append(_z2(filler - filler // 2))
    ivs.append(_cd(5))
    return {
        "name": f"{_TAG}Sweet Spot {reps}×{rep_min}min",
        "description": f"{reps}×{rep_min}min at 88-93% FTP. Core sweet spot development.",
        "intervals": ivs,
    }


def w_threshold(reps: int, rep_min: int, total_mins: int = 60) -> dict:
    parts   = [_thr(rep_min) for _ in range(reps)]
    main    = _interleave(parts, 3)
    work    = rep_min * reps + 3 * (reps - 1)
    filler  = max(total_mins - 15 - work, 0)
    ivs     = [_wu(10)]
    if filler > 0:
        ivs.append(_z2(filler))
    ivs.extend(main)
    ivs.append(_cd(5))
    return {
        "name": f"{_TAG}Threshold {reps}×{rep_min}min",
        "description": f"{reps}×{rep_min}min at 95-100% FTP. Raises your sustainable power.",
        "intervals": ivs,
    }


def w_vo2max(reps: int, rep_min: int, total_mins: int = 60) -> dict:
    parts   = [_vo2(rep_min) for _ in range(reps)]
    main    = _interleave(parts, rep_min)   # 1:1 work : rest
    work    = rep_min * 2 * reps - rep_min  # last rest omitted
    filler  = max(total_mins - 20 - work, 0)
    ivs     = [_wu(15)]
    if filler > 0:
        ivs.append(_z2(filler))
    ivs.extend(main)
    ivs.append(_cd(5))
    return {
        "name": f"{_TAG}VO2 Max {reps}×{rep_min}min",
        "description": f"{reps}×{rep_min}min at 115%+ FTP. Develops your aerobic ceiling.",
        "intervals": ivs,
    }


# ── Session-type library ───────────────────────────────────────────────
# Fixed-duration sessions (don't scale with session preference)
_FIXED: dict[str, callable] = {
    "recovery":       lambda: w_recovery(35),
    "sweetspot_easy": lambda: w_sweetspot(1, 10, 45),
    "sweetspot_1x15": lambda: w_sweetspot(1, 15, 50),
    "sweetspot_2x12": lambda: w_sweetspot(2, 12, 55),
    "sweetspot_2x15": lambda: w_sweetspot(2, 15, 60),
    "sweetspot_3x12": lambda: w_sweetspot(3, 12, 65),
    "sweetspot_3x15": lambda: w_sweetspot(3, 15, 75),
    "threshold_1x8":  lambda: w_threshold(1,  8, 45),
    "threshold_2x8":  lambda: w_threshold(2,  8, 55),
    "threshold_2x10": lambda: w_threshold(2, 10, 60),
    "threshold_3x8":  lambda: w_threshold(3,  8, 65),
    "vo2_4x3":        lambda: w_vo2max(4, 3, 55),
    "vo2_5x3":        lambda: w_vo2max(5, 3, 60),
    "vo2_5x4":        lambda: w_vo2max(5, 4, 70),
}

# Variable-duration sessions (scale with the user's session_mins preference)
_VARIABLE: dict[str, callable] = {
    "endurance_easy": lambda m: w_endurance(max(int(m * 0.75), 30)),
    "endurance":      lambda m: w_endurance(m),
    "endurance_long": lambda m: w_endurance(int(m * 1.35)),
    "endurance_xl":   lambda m: w_endurance(int(m * 1.65)),
}


def _build_session(stype: str, base_mins: int) -> dict:
    if stype in _FIXED:
        return _FIXED[stype]()
    if stype in _VARIABLE:
        return _VARIABLE[stype](base_mins)
    return w_endurance(base_mins)


# ── 6-week plan templates ──────────────────────────────────────────────
# Lists of session-type strings, one per training day.
# Layout: 6 blocks × days_per_week sessions, in 3:1 periodization
# (W1=easy, W2=medium, W3=hard, W4=recovery, W5=hard, W6=peak)

_PLANS: dict[str, dict[int, list[str]]] = {

    "base_fitness": {
        3: [
            # W1 easy
            "endurance", "sweetspot_easy", "endurance_long",
            # W2 medium
            "endurance", "sweetspot_1x15", "endurance_long",
            # W3 hard
            "endurance", "sweetspot_2x12", "endurance_long",
            # W4 recovery
            "recovery", "endurance_easy", "recovery",
            # W5 hard
            "endurance", "sweetspot_2x15", "endurance_long",
            # W6 peak
            "endurance", "threshold_1x8", "endurance_xl",
        ],
        4: [
            "endurance", "sweetspot_easy", "recovery", "endurance_long",
            "endurance", "sweetspot_1x15", "recovery", "endurance_long",
            "endurance", "sweetspot_2x12", "recovery", "endurance_long",
            "recovery",  "endurance_easy", "recovery", "endurance_easy",
            "endurance", "sweetspot_2x15", "recovery", "endurance_long",
            "endurance", "threshold_1x8",  "recovery", "endurance_xl",
        ],
        5: [
            "endurance", "sweetspot_easy", "recovery", "sweetspot_easy",    "endurance_long",
            "endurance", "sweetspot_1x15", "recovery", "sweetspot_easy",    "endurance_long",
            "endurance", "sweetspot_2x12", "recovery", "sweetspot_1x15",    "endurance_long",
            "recovery",  "endurance_easy", "recovery", "endurance_easy",    "recovery",
            "endurance", "sweetspot_2x15", "recovery", "sweetspot_2x12",    "endurance_long",
            "endurance", "threshold_1x8",  "recovery", "sweetspot_2x15",    "endurance_xl",
        ],
    },

    "build_fitness": {
        3: [
            "endurance",      "sweetspot_2x12", "endurance_long",
            "sweetspot_2x15", "threshold_1x8",  "endurance_long",
            "sweetspot_3x12", "threshold_2x8",  "endurance_long",
            "recovery",       "endurance_easy",  "recovery",
            "sweetspot_3x12", "threshold_2x10", "endurance_long",
            "threshold_2x10", "vo2_4x3",         "endurance_xl",
        ],
        4: [
            "endurance",      "sweetspot_2x12", "recovery", "endurance_long",
            "sweetspot_2x12", "threshold_1x8",  "recovery", "endurance_long",
            "sweetspot_2x15", "threshold_2x8",  "recovery", "endurance_long",
            "recovery",       "endurance_easy",  "recovery", "endurance_easy",
            "sweetspot_3x12", "threshold_2x8",  "recovery", "endurance_long",
            "threshold_2x10", "vo2_4x3",         "recovery", "endurance_xl",
        ],
        5: [
            "endurance",      "sweetspot_2x12", "recovery", "threshold_1x8",  "endurance_long",
            "sweetspot_2x12", "threshold_1x8",  "recovery", "sweetspot_2x12", "endurance_long",
            "sweetspot_2x15", "threshold_2x8",  "recovery", "sweetspot_2x15", "endurance_long",
            "recovery",       "endurance_easy",  "recovery", "endurance_easy", "recovery",
            "sweetspot_3x12", "threshold_2x8",  "recovery", "threshold_1x8",  "endurance_long",
            "threshold_2x10", "vo2_4x3",         "recovery", "sweetspot_3x12", "endurance_xl",
        ],
    },

    "century": {
        3: [
            "endurance",      "sweetspot_easy", "endurance_long",
            "endurance_long", "sweetspot_1x15", "endurance_xl",
            "endurance_long", "sweetspot_2x12", "endurance_xl",
            "recovery",       "endurance_easy", "recovery",
            "endurance_long", "sweetspot_2x12", "endurance_xl",
            "endurance_long", "sweetspot_2x15", "endurance_xl",
        ],
        4: [
            "endurance",      "sweetspot_easy", "recovery", "endurance_long",
            "endurance_long", "sweetspot_1x15", "recovery", "endurance_xl",
            "endurance_long", "sweetspot_2x12", "recovery", "endurance_xl",
            "recovery",       "endurance_easy", "recovery", "endurance",
            "endurance_long", "sweetspot_2x12", "recovery", "endurance_xl",
            "endurance_long", "sweetspot_2x15", "recovery", "endurance_xl",
        ],
        5: [
            "endurance",      "sweetspot_easy", "recovery", "endurance",      "endurance_long",
            "endurance_long", "sweetspot_1x15", "recovery", "endurance",      "endurance_xl",
            "endurance_long", "sweetspot_2x12", "recovery", "sweetspot_easy", "endurance_xl",
            "recovery",       "endurance_easy", "recovery", "endurance_easy", "recovery",
            "endurance_long", "sweetspot_2x12", "recovery", "sweetspot_1x15", "endurance_xl",
            "endurance_long", "sweetspot_2x15", "recovery", "sweetspot_2x12", "endurance_xl",
        ],
    },

    "race_prep": {
        3: [
            "endurance",      "sweetspot_2x12", "endurance_long",
            "sweetspot_2x15", "threshold_2x8",  "endurance_long",
            "sweetspot_3x12", "threshold_2x10", "endurance_long",
            "recovery",       "endurance_easy",  "recovery",
            "threshold_2x10", "vo2_4x3",         "endurance_long",
            "threshold_3x8",  "vo2_5x3",         "endurance",
        ],
        4: [
            "endurance",      "sweetspot_2x12", "recovery", "endurance_long",
            "sweetspot_2x15", "threshold_1x8",  "recovery", "endurance_long",
            "sweetspot_3x12", "threshold_2x8",  "recovery", "endurance_long",
            "recovery",       "endurance_easy",  "recovery", "endurance_easy",
            "threshold_2x10", "vo2_4x3",         "recovery", "endurance_long",
            "threshold_3x8",  "vo2_5x3",         "recovery", "endurance",
        ],
        5: [
            "endurance",      "sweetspot_2x12", "recovery", "threshold_1x8",  "endurance_long",
            "sweetspot_2x15", "threshold_2x8",  "recovery", "sweetspot_2x12", "endurance_long",
            "sweetspot_3x12", "threshold_2x10", "recovery", "threshold_2x8",  "endurance_long",
            "recovery",       "endurance_easy",  "recovery", "endurance_easy", "recovery",
            "threshold_2x10", "vo2_4x3",         "recovery", "threshold_2x8",  "endurance_long",
            "threshold_3x8",  "vo2_5x4",         "recovery", "sweetspot_3x12", "endurance",
        ],
    },
}

# Training day patterns by days-per-week (weekday numbers: 0=Mon … 6=Sun)
_DAY_PATTERNS: dict[int, list[int]] = {
    3: [1, 3, 5],           # Tue  Thu  Sat
    4: [1, 3, 5, 6],        # Tue  Thu  Sat  Sun
    5: [0, 1, 3, 5, 6],     # Mon  Tue  Thu  Sat  Sun
    6: [0, 1, 2, 4, 5, 6],  # Mon  Tue  Wed  Fri  Sat  Sun
    7: [0, 1, 2, 3, 4, 5, 6],
}


# ── Public API ────────────────────────────────────────────────────────

def generate_plan(
    goal: str,
    level: str,
    days_per_week: int,
    session_mins: int,
    start_date: Optional[date] = None,
) -> list[tuple[str, dict]]:
    """
    Return [(date_iso, workout_dict), …] for a 6-week plan.
    """
    # Normalise inputs
    goal          = goal if goal in _PLANS else "base_fitness"
    days_per_week = max(3, min(days_per_week, 7))
    level_scale   = {"beginner": 0.85, "intermediate": 1.0, "advanced": 1.15}.get(level, 1.0)
    eff_mins      = max(int(session_mins * level_scale), 30)

    # Use the closest template (max 5) and expand to 6/7 by inserting recovery days
    base_days     = min(days_per_week, 5)
    session_types = list(_PLANS[goal].get(base_days) or _PLANS[goal][4])

    if days_per_week > 5:
        extra = days_per_week - 5
        # For each week, insert `extra` recovery/endurance slots at the front
        week_len  = 5
        expanded  = []
        for w in range(6):
            week = session_types[w * week_len:(w + 1) * week_len]
            # add extra easy sessions before the main block
            additions = (["recovery"] * extra) if w % 4 == 3 else (["endurance_easy"] * extra)
            expanded.extend(additions + week)
        session_types = expanded

    # Start on next Monday (or today if today is Monday)
    from_date = start_date or date.today()
    days_ahead = (7 - from_date.weekday()) % 7
    start = from_date + timedelta(days=days_ahead)

    # Generate training dates
    pattern = _DAY_PATTERNS[days_per_week]
    dates: list[date] = []
    cursor = start
    while len(dates) < len(session_types):
        if cursor.weekday() in pattern:
            dates.append(cursor)
        cursor += timedelta(days=1)

    return [
        (d.isoformat(), _build_session(stype, eff_mins))
        for d, stype in zip(dates, session_types)
    ]


def compute_adaptation(rides: list[dict]) -> tuple[float, str, str]:
    """
    Analyse adherence over the last 5 completed rides.

    Returns:
        factor  – power_pct adjustment multiplier (-0.15 … +0.08)
        status  – "on_track" | "adjusted_up" | "adjusted_down"
        message – human-readable summary
    """
    recent = [r for r in rides[:8] if r.get("completed")][:5]

    if not recent:
        return 0.0, "on_track", "Complete your first workout to unlock adaptive adjustments."

    scores: list[float] = []
    for r in recent:
        total     = r.get("total_duration", 1) or 1
        elapsed   = r.get("elapsed", 0)
        completion = min(elapsed / total, 1.05)

        # Intensity factor ratio (0.75 is typical avg IF for a mixed training week)
        actual_if = r.get("intensity_factor") or 0.75
        if_ratio  = min(actual_if / 0.75, 1.15)

        scores.append(completion * 0.65 + if_ratio * 0.35)

    avg = sum(scores) / len(scores)
    n   = len(scores)

    if avg >= 0.95:
        return (
            0.08,
            "adjusted_up",
            f"You're nailing it — {avg*100:.0f}% adherence across your last {n} rides. "
            "Next sessions bumped up slightly to keep the stimulus fresh.",
        )
    elif avg >= 0.82:
        return (
            0.0,
            "on_track",
            f"Solid consistency ({avg*100:.0f}% adherence). Plan is progressing as intended.",
        )
    elif avg >= 0.65:
        return (
            -0.08,
            "adjusted_down",
            f"Adherence at {avg*100:.0f}% — upcoming sessions eased slightly "
            "to help you absorb the load.",
        )
    else:
        return (
            -0.15,
            "adjusted_down",
            f"Adherence at {avg*100:.0f}% — significant load reduction applied. "
            "Focus on finishing sessions before adding intensity.",
        )


def apply_adaptation(workout: dict, factor: float) -> dict:
    """
    Return a copy of workout with interval power_pct values scaled by (1 + factor).
    Only adjusts effort intervals (leaves warm-up / cool-down / rest unchanged).
    """
    if abs(factor) < 0.005:
        return workout

    SKIP_LABELS = {"Warm-up", "Cool-down", "Rest", "Rest Interval", "Recovery"}

    w = copy.deepcopy(workout)
    for iv in w.get("intervals", []):
        if iv.get("label") not in SKIP_LABELS:
            pct = iv.get("power_pct", 0)
            if pct > 0:
                iv["power_pct"] = max(round(pct * (1 + factor), 3), 0.40)
    return w
