"""
FreeTrain coach chat — AI-free conversational state machine.

Pure functions only: no I/O, no DB access, no network calls (mirrors how
plan_engine.py / run_plan_engine.py stay pure while main.py does all the
persistence/broadcast work).

All coach-authored text passes through compose_message() below — today a
plain template lookup, no API calls, no cost. This is the one seam a
future AI integration would touch (to rephrase the same structured
`context` more naturally, decisions staying deterministic); no other code
in this module or its callers should ever format coach-facing text
directly.
"""

from __future__ import annotations

from typing import Optional

# ── Onboarding step sequence ────────────────────────────────────────
# Bike steps are skipped when discipline == 'running'; run steps are
# skipped when discipline == 'cycling'. 'notes' and 'confirm' always run.
# bike_style/run_style ('road'|'mountain' and 'road'|'trail') are answered
# right after picking the discipline and drive which goal options show up
# next — the underlying indoor ERG training/mileage-target math is the
# same regardless of surface, so only the framing changes, not the engine.
_ALL_STEPS = [
    "discipline",
    "bike_style", "bike_goal", "bike_level", "bike_days", "bike_hours", "bike_ftp",
    "run_style", "run_goal", "run_level", "run_days", "run_miles",
    "notes",
    "confirm",
]

_BIKE_STEPS = {"bike_style", "bike_goal", "bike_level", "bike_days", "bike_hours", "bike_ftp"}
_RUN_STEPS  = {"run_style", "run_goal", "run_level", "run_days", "run_miles"}

# Steps whose value is a plain number rather than a quick-reply choice.
NUMERIC_STEPS = {"bike_ftp", "bike_days", "bike_hours", "run_days", "run_miles"}


def _steps_for(discipline: str) -> list[str]:
    steps = []
    for s in _ALL_STEPS:
        if s in _BIKE_STEPS and discipline == "running":
            continue
        if s in _RUN_STEPS and discipline == "cycling":
            continue
        steps.append(s)
    return steps


def next_step(discipline: str, current_step: Optional[str]) -> Optional[str]:
    """Return the step after `current_step` for this discipline, or None when onboarding is complete."""
    steps = _steps_for(discipline or "both")
    if current_step is None:
        return steps[0]
    try:
        i = steps.index(current_step)
    except ValueError:
        return steps[0]
    return steps[i + 1] if i + 1 < len(steps) else None


# ── Quick-reply option sets (values match plan_engine/run_plan_engine args) ──
# Goal *values* are identical across styles — indoor ERG training and
# mileage targets don't actually change based on surface — only the
# label wording changes so the choice reads naturally for each style.
_BIKE_GOALS_ROAD = [
    {"value": "base_fitness",  "label": "Base Fitness"},
    {"value": "build_fitness", "label": "Build Fitness"},
    {"value": "century",       "label": "Century / Gran Fondo"},
    {"value": "race_prep",     "label": "Race Prep"},
]
_BIKE_GOALS_MTB = [
    {"value": "base_fitness",  "label": "Base Fitness"},
    {"value": "build_fitness", "label": "Build Fitness"},
    {"value": "century",       "label": "Endurance / All-Day Ride"},
    {"value": "race_prep",     "label": "XC / Enduro Race Prep"},
]
_RUN_GOALS_ROAD = [
    {"value": "base_mileage",  "label": "Base Mileage"},
    {"value": "five_k",        "label": "5K"},
    {"value": "ten_k",         "label": "10K"},
    {"value": "half_marathon", "label": "Half Marathon"},
    {"value": "marathon",      "label": "Marathon"},
]
_RUN_GOALS_TRAIL = [
    {"value": "base_mileage",  "label": "Base Mileage"},
    {"value": "half_marathon", "label": "Trail Half Marathon"},
    {"value": "marathon",      "label": "Trail Marathon"},
    {"value": "ultra",         "label": "Ultra (50K+)"},
]
_LEVELS = [
    {"value": "beginner",     "label": "Beginner"},
    {"value": "intermediate", "label": "Intermediate"},
    {"value": "advanced",     "label": "Advanced"},
]
_BIKE_DAYS   = [{"value": str(n), "label": str(n)} for n in (3, 4, 5, 6, 7)]
_RUN_DAYS    = [{"value": str(n), "label": str(n)} for n in (3, 4, 5, 6)]   # generate_run_plan caps at 6
_BIKE_HOURS  = [{"value": str(n), "label": f"{n} hrs"} for n in (3, 5, 7, 10)]
_DISCIPLINE  = [
    {"value": "cycling", "label": "Cycling"},
    {"value": "running", "label": "Running"},
    {"value": "both",    "label": "Both"},
]
_BIKE_STYLE = [
    {"value": "road",     "label": "Road"},
    {"value": "mountain", "label": "Mountain"},
]
_RUN_STYLE = [
    {"value": "road",  "label": "Road"},
    {"value": "trail", "label": "Trail"},
]

_STEP_META: dict[str, dict] = {
    "discipline": {"text": "Want a training plan? Let's set one up — cycling, running, or both?",
                   "type": "quick_reply", "options": _DISCIPLINE},
    "bike_style": {"text": "Road or mountain biking?",
                   "type": "quick_reply", "options": _BIKE_STYLE},
    "bike_level": {"text": "What's your cycling experience level?",
                   "type": "quick_reply", "options": _LEVELS},
    "bike_days":  {"text": "How many days a week do you want to ride?",
                   "type": "quick_reply", "options": _BIKE_DAYS},
    "bike_hours": {"text": "About how many hours a week can you train?",
                   "type": "quick_reply", "options": _BIKE_HOURS},
    "bike_ftp":   {"text": "What's your current FTP, in watts? A rough guess is fine.",
                   "type": "number_input", "unit": "W", "placeholder": "e.g. 220"},
    "run_style":  {"text": "Road or trail running?",
                   "type": "quick_reply", "options": _RUN_STYLE},
    "run_level":  {"text": "What's your running experience level?",
                   "type": "quick_reply", "options": _LEVELS},
    "run_days":   {"text": "How many days a week do you want to run?",
                   "type": "quick_reply", "options": _RUN_DAYS},
    "run_miles":  {"text": "About how many miles a week do you want to target?",
                   "type": "number_input", "unit": "mi", "placeholder": "e.g. 15"},
    "notes":      {"text": "Anything else I should know — injuries, an upcoming event, a break "
                           "you're returning from? Optional — type it, or say Skip.",
                   "type": "free_text"},
    "confirm":    {"text": "Ready to generate your 6-week plan?",
                   "type": "quick_reply",
                   "options": [{"value": "generate", "label": "Generate my plan"},
                               {"value": "restart",  "label": "Start over"}]},
}


def _goal_options(step: str, profile_partial: dict) -> list[dict]:
    if step == "bike_goal":
        return _BIKE_GOALS_MTB if profile_partial.get("bike_style") == "mountain" else _BIKE_GOALS_ROAD
    return _RUN_GOALS_TRAIL if profile_partial.get("run_style") == "trail" else _RUN_GOALS_ROAD


def step_prompt(step: str, profile_partial: dict) -> dict:
    """Return {text, message_type, payload} for the given onboarding step."""
    if step == "bike_goal":
        text = compose_message("onboarding_step", {"step": step, "text": "What's your cycling goal?", "profile": profile_partial})
        return {"text": text, "message_type": "quick_reply",
                "payload": {"step": step, "options": _goal_options(step, profile_partial)}}
    if step == "run_goal":
        text = compose_message("onboarding_step", {"step": step, "text": "What's your running goal?", "profile": profile_partial})
        return {"text": text, "message_type": "quick_reply",
                "payload": {"step": step, "options": _goal_options(step, profile_partial)}}

    meta = _STEP_META[step]
    text = compose_message("onboarding_step", {"step": step, "text": meta["text"], "profile": profile_partial})
    if meta["type"] == "quick_reply":
        return {"text": text, "message_type": "quick_reply",
                "payload": {"step": step, "options": meta["options"]}}
    if meta["type"] == "number_input":
        return {"text": text, "message_type": "number_input",
                "payload": {"step": step, "unit": meta["unit"], "placeholder": meta["placeholder"]}}
    return {"text": text, "message_type": "free_text", "payload": {"step": step}}


# ── Post-workout check-in ───────────────────────────────────────────
CHECKIN_OPTIONS = [
    {"value": "too_easy",   "label": "Too easy"},
    {"value": "just_right", "label": "Just right"},
    {"value": "too_hard",   "label": "Too hard"},
]


def checkin_prompt(activity_kind: str, activity_name: str) -> dict:
    """activity_kind: 'ride' | 'run'. Returns {text, message_type, payload}."""
    label = "ride" if activity_kind == "ride" else "run"
    text = compose_message("checkin_prompt", {"kind": activity_kind, "name": activity_name, "label": label})
    return {"text": text, "message_type": "quick_reply",
            "payload": {"kind": activity_kind, "options": CHECKIN_OPTIONS}}


# ── The AI swap-in seam ──────────────────────────────────────────────

def compose_message(kind: str, context: dict) -> str:
    """
    Single seam for all coach-authored text. Today this is a pure template
    lookup — no API calls, no cost, no network. A future AI integration
    (rephrasing the coach's voice; decisions stay deterministic elsewhere)
    would swap the branches below for a call that takes the same `context`
    dict and returns a string, keeping this template path as a fallback.
    """
    if kind == "onboarding_step":
        return context["text"]

    if kind == "checkin_prompt":
        name = context.get("name") or f"your {context['label']}"
        return f"How did {name} feel?"

    if kind == "adaptation_result":
        # `message` is already a complete sentence from compute_adaptation /
        # compute_run_adaptation — pass it through unchanged.
        return context.get("message", "")

    return context.get("text", "")
