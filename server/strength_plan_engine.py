"""
FreeTrain adaptive strength-training plan engine.

Generates periodized strength plans of any length (1-24 weeks) and
adapts upcoming session durations based on adherence and the athlete's
own post-session feedback.

Deliberately NOT a copy of the endurance engines. Strength sessions are
recorded at session level (duration + focus + perceived effort), so the
plan schedules a rotating focus pattern with progressive session
duration, rather than distributing a weekly distance budget. It also
skips the injury-oriented "load ramp" signal the running engine uses —
weekly minutes lifted is a poor proxy for mechanical load, so leaning on
it would be false precision.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

# Goals that finish with a deload rather than a peak week.
_TAPER_GOALS = {"event_prep", "peak_strength"}

_FOCUS_DESCRIPTIONS = {
    "upper": "Upper body — pressing, pulling, and shoulder stability work.",
    "lower": "Lower body — squat and hinge patterns, single-leg work.",
    "full":  "Full body — compound lifts hitting both upper and lower.",
    "core":  "Core and stability — trunk, hips, and anti-rotation work.",
}

# Which focus lands on each training day, by days-per-week. Ordered so
# consecutive days don't repeat the same focus where avoidable.
_FOCUS_PATTERNS: dict[int, list[str]] = {
    1: ["full"],
    2: ["full", "full"],
    3: ["upper", "lower", "full"],
    4: ["upper", "lower", "upper", "lower"],
    5: ["upper", "lower", "core", "upper", "lower"],
}

# Relative session length by focus — core/stability days are shorter.
_FOCUS_DURATION_MULT = {"upper": 1.0, "lower": 1.0, "full": 1.05, "core": 0.65}

# Training day patterns (0=Mon … 6=Sun). Strength days are spaced to
# leave recovery between sessions hitting the same muscle groups.
_DAY_PATTERNS: dict[int, list[int]] = {
    1: [2],                 # Wed
    2: [1, 4],              # Tue  Fri
    3: [0, 2, 4],           # Mon  Wed  Fri
    4: [0, 1, 3, 4],        # Mon  Tue  Thu  Fri
    5: [0, 1, 2, 3, 4],     # Mon-Fri
}

# Plan length
DEFAULT_WEEKS = 6
MIN_WEEKS     = 1
MAX_WEEKS     = 24

DEFAULT_SESSION_MINS = 45

_WEEK_CAP     = 1.20
_MIN_SESSION  = 20    # never schedule a session shorter than 20 min
_MAX_SESSION  = 120   # or longer than 2 hours


def week_factors(weeks: int, taper: bool) -> list[float]:
    """
    3:1 periodization of arbitrary length, as a fraction of the target
    session duration: three progressively longer weeks, then a deload
    week at 70%, repeating — each 4-week block starting 15% higher,
    capped at 120%. Taper goals end on a deload.
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

def generate_strength_plan(
    goal: str,
    level: str,
    days_per_week: int,
    session_mins: float = DEFAULT_SESSION_MINS,
    weeks: int = DEFAULT_WEEKS,
    start_date: Optional[date] = None,
) -> list[tuple[str, dict]]:
    """Return [(date_iso, entry_dict), …] for a `weeks`-long strength plan."""
    days_per_week = max(1, min(days_per_week, 5))
    weeks   = max(MIN_WEEKS, min(int(weeks or DEFAULT_WEEKS), MAX_WEEKS))
    pattern_focus = _FOCUS_PATTERNS[days_per_week]
    factors = week_factors(weeks, taper=goal in _TAPER_GOALS)

    level_scale = {"beginner": 0.80, "intermediate": 1.0, "advanced": 1.15}.get(level, 1.0)
    base_mins   = (session_mins or DEFAULT_SESSION_MINS) * level_scale

    entries: list[dict] = []
    for wf in factors:
        for focus in pattern_focus:
            mins = base_mins * wf * _FOCUS_DURATION_MULT[focus]
            mins = max(_MIN_SESSION, min(round(mins), _MAX_SESSION))
            entries.append({
                "focus":               focus,
                "target_duration_min": mins,
                "description":         _FOCUS_DESCRIPTIONS[focus],
            })

    from_date  = start_date or date.today()
    days_ahead = (7 - from_date.weekday()) % 7
    start      = from_date + timedelta(days=days_ahead)

    day_pattern = _DAY_PATTERNS[days_per_week]
    dates: list[date] = []
    cursor = start
    while len(dates) < len(entries):
        if cursor.weekday() in day_pattern:
            dates.append(cursor)
        cursor += timedelta(days=1)

    return [(d.isoformat(), e) for d, e in zip(dates, entries)]


def compute_strength_adaptation(sessions: list[dict],
                                plan_entries: dict[str, dict]) -> tuple[float, str, str]:
    """
    Two signals — adherence and subjective feedback.

    There is deliberately no load-ramp signal here: total minutes lifted
    says little about mechanical load (a 30-minute heavy session can be
    far more demanding than a 60-minute light one), so inferring injury
    risk from it would be false precision. Perceived effort and adherence
    are the honest signals available from session-level records.

    Returns (factor, status, message) with factor in -0.15 … +0.10.
    """
    def _sdate(s) -> Optional[date]:
        try:
            return date.fromisoformat(str(s.get("date", ""))[:10])
        except ValueError:
            return None

    today = date.today()
    done_by_date: dict[str, float] = {}
    for s in sessions:
        d = _sdate(s)
        if d:
            key = d.isoformat()
            mins = (s.get("elapsed") or 0) / 60
            done_by_date[key] = done_by_date.get(key, 0) + mins

    past_planned = [
        (ds, e) for ds, e in plan_entries.items()
        if ds <= today.isoformat() and (e.get("target_duration_min") or 0) > 0
    ]
    past_planned.sort(key=lambda x: x[0], reverse=True)
    recent = past_planned[:12]

    if not recent:
        return 0.0, "on_track", "Log your first planned strength session to unlock adaptive adjustments."

    scores = []
    for ds, e in recent:
        target = e.get("target_duration_min") or 1
        actual = done_by_date.get(ds, 0)
        scores.append(min(actual / target, 1.15))

    avg = sum(scores) / len(scores)
    n   = len(scores)

    if avg >= 0.95:
        factor, note = 0.08, f"Strong consistency — completing {avg*100:.0f}% of planned time across your last {n} sessions."
    elif avg >= 0.80:
        factor, note = 0.0, f"Solid consistency ({avg*100:.0f}% of planned time)."
    elif avg >= 0.60:
        factor, note = -0.08, f"Completing {avg*100:.0f}% of planned time — upcoming sessions shortened slightly."
    else:
        factor, note = -0.15, f"Completing {avg*100:.0f}% of planned time — sessions shortened to something more sustainable."

    # ── Subjective feedback ──────────────────────────────────────────
    # Weighted a little harder than the endurance engines: with no
    # objective load metric, how the athlete felt is the best signal here.
    fb_nudges = {"too_easy": 0.05, "just_right": 0.0, "too_hard": -0.07}
    fb_by_date: dict[str, str] = {}
    for s in sessions:
        d = _sdate(s)
        if d and s.get("feedback"):
            fb_by_date[d.isoformat()] = s["feedback"]
    fb_values = [fb_by_date[ds] for ds, _ in recent if ds in fb_by_date]
    if fb_values:
        fb_delta = sum(fb_nudges.get(f, 0.0) for f in fb_values) / len(fb_values)
        if abs(fb_delta) >= 0.01:
            factor += fb_delta
            note += (" You've told me recent sessions felt easy, so they're extended a little."
                      if fb_delta > 0 else
                      " You've flagged recent sessions as tough, so they're pulled back further.")
        # Hitting every target doesn't justify more work when the athlete
        # is telling us it's too hard — negative feedback always wins over
        # a positive adherence bonus.
        if fb_delta < 0:
            factor = min(factor, fb_delta)

    # Perceived effort, where recorded, refines the same picture.
    efforts = [s.get("perceived_effort") for s in sessions
               if _sdate(s) and (today - _sdate(s)).days < 14 and s.get("perceived_effort")]
    if len(efforts) >= 2:
        mean_rpe = sum(efforts) / len(efforts)
        if mean_rpe >= 8.5:
            factor -= 0.04
            note += f" Recent sessions have averaged RPE {mean_rpe:.1f} — easing off to let you recover."
        elif mean_rpe <= 4.0 and avg >= 0.80:
            factor += 0.03
            note += f" Recent sessions have averaged RPE {mean_rpe:.1f}, so there's room for more."

    factor = max(-0.15, min(0.10, factor))
    status = ("adjusted_up" if factor > 0.02
              else "adjusted_down" if factor < -0.02
              else "on_track")
    if status == "on_track" and not note.endswith("more."):
        note += " Plan is progressing as intended."
    return factor, status, note


def apply_strength_adaptation(entry: dict, factor: float) -> dict:
    """Return a copy of entry with target duration scaled by (1 + factor)."""
    if abs(factor) < 0.005:
        return entry

    e = dict(entry)
    dur = e.get("target_duration_min") or 0
    if dur > 0:
        e["target_duration_min"] = max(_MIN_SESSION, min(round(dur * (1 + factor)), _MAX_SESSION))
    return e
