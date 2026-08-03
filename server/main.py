"""FreeTrain – FastAPI server with Supabase auth + data, BLE backend."""
import asyncio
import logging
import threading
import webbrowser
from datetime import datetime, timedelta, timezone
from typing import Optional

import uvicorn
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

import coach_engine
import strava
from ble_manager import BLEManager
from plan_engine import apply_adaptation, compute_adaptation, generate_plan
from run_plan_engine import apply_run_adaptation, compute_run_adaptation, generate_run_plan
from supabase_client import (
    SUPABASE_ANON_KEY, SUPABASE_URL,
    clear_generated_plan, clear_run_plan, delete_ride, delete_run,
    delete_strava_connection, delete_workout, get_athlete_profile,
    get_coach_messages, get_plan, get_rides, get_rides_needing_checkin,
    get_run_plan, get_runs, get_runs_needing_checkin, get_strava_connection,
    get_upcoming_generated_workouts, get_workouts,
    save_athlete_profile, save_coach_message, save_generated_plan,
    save_ride, save_run, save_run_plan,
    save_strava_connection, save_workout, set_plan_day, set_ride_feedback,
    set_ride_strava_id, set_run_feedback, set_run_plan_day,
    update_run_plan_entry, update_workout_intervals, verify_token,
)
from workout_engine import WorkoutEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
log = logging.getLogger(__name__)

app = FastAPI(title="FreeTrain")

from pathlib import Path
ROOT       = Path(__file__).parent.parent
STATIC_DIR = ROOT / "static"

ble = BLEManager()

# user_id → active WorkoutEngine
_engines: dict[str, WorkoutEngine] = {}

# user_id → set of live WebSockets
_sockets: dict[str, set[WebSocket]] = {}


# ── Config endpoint (exposes only public/safe env vars) ──────────────

@app.get("/config.js", response_class=Response)
async def config_js():
    js = (
        f"window.APP_CONFIG = {{\n"
        f'  supabaseUrl: "{SUPABASE_URL}",\n'
        f'  supabaseAnonKey: "{SUPABASE_ANON_KEY}",\n'
        f'  stravaClientId: "{strava.STRAVA_CLIENT_ID}"\n'
        f"}};\n"
    )
    return Response(content=js, media_type="application/javascript")


# ── Strava OAuth callback ─────────────────────────────────────────────

@app.get("/strava/callback")
async def strava_callback(code: str = Query(default=None),
                          state: str = Query(default=None),
                          error: str = Query(default=None)):
    if error or not code:
        return RedirectResponse("/?strava=denied")
    user_id = verify_token(state) if state else None
    if not user_id:
        return RedirectResponse("/?strava=error")
    try:
        tokens = await strava.exchange_code(code)
        await save_strava_connection(user_id, tokens)
        log.info("Strava connected: user=%s athlete=%s",
                 user_id, (tokens.get("athlete") or {}).get("id"))
        return RedirectResponse("/?strava=connected")
    except Exception as exc:
        log.warning("Strava token exchange failed: %s", exc)
        return RedirectResponse("/?strava=error")


async def _strava_fresh_token(user_id: str) -> str | None:
    """Return a valid access token for the user, refreshing if expired."""
    conn = await get_strava_connection(user_id)
    if not conn:
        return None
    now = int(datetime.now(timezone.utc).timestamp())
    if conn["expires_at"] > now + 60:
        return conn["access_token"]
    try:
        tokens = await strava.refresh_tokens(conn["refresh_token"])
        await save_strava_connection(user_id, tokens)
        return tokens["access_token"]
    except Exception as exc:
        log.warning("Strava token refresh failed: %s", exc)
        return None


async def _strava_upload_task(user_id: str, ride_id: str, ride: dict):
    """Background: upload a completed ride to Strava and link the activity."""
    token = await _strava_fresh_token(user_id)
    if not token:
        return

    samples = ride.get("power_samples") or []
    if len(samples) < 30:
        return   # nothing meaningful to upload

    start = datetime.now(timezone.utc) - timedelta(seconds=ride.get("elapsed", len(samples)))
    name  = ride.get("workout_name") or "FreeTrain Workout"
    tcx   = strava.build_tcx(start, samples, name)

    activity_id = await strava.upload_activity(token, tcx, name)
    if activity_id:
        await set_ride_strava_id(ride_id, activity_id)
        rides = await get_rides(user_id)
        await _broadcast(user_id, {"type": "history_updated", "rides": rides})
        await _broadcast(user_id, {
            "type":        "strava_uploaded",
            "activity_id": activity_id,
            "message":     "Ride uploaded to Strava",
        })
    else:
        await _broadcast(user_id, {
            "type":    "error",
            "message": "Strava upload failed — the ride is still saved in FreeTrain.",
        })


async def _run_adaptation(user_id: str, post_as_coach_message: bool = False):
    """Recompute adaptation from all rides and adjust upcoming generated workouts."""
    rides_all = await get_rides(user_id)
    factor, status, message = compute_adaptation(rides_all)
    upcoming  = await get_upcoming_generated_workouts(user_id, limit=3)
    adjusted  = 0
    for entry in upcoming:
        w   = entry["workout"]
        new = apply_adaptation(w, factor)
        if new["intervals"] != w["intervals"]:
            await update_workout_intervals(w["id"], new["intervals"])
            adjusted += 1

    if upcoming:
        await _broadcast(user_id, {
            "type":              "adaptation_feedback",
            "status":            status,
            "message":           message,
            "workouts_adjusted": adjusted,
        })
        if post_as_coach_message:
            await _post_coach_text(user_id, coach_engine.compose_message(
                "adaptation_result", {"status": status, "message": message, "factor": factor},
            ))
    if adjusted:
        workouts = await get_workouts(user_id)
        await _broadcast(user_id, {"type": "workouts_updated", "workouts": workouts})


async def _run_run_adaptation(user_id: str, post_as_coach_message: bool = False):
    """Recompute run adaptation and adjust the next few planned run days."""
    runs_all  = await get_runs(user_id)
    run_plan  = await get_run_plan(user_id)
    factor, status, message = compute_run_adaptation(runs_all, run_plan)

    today = datetime.now(timezone.utc).date().isoformat()
    upcoming = sorted(
        (ds, e) for ds, e in run_plan.items()
        if ds >= today and (e.get("target_distance_m") or 0) > 0
    )[:3]

    adjusted = 0
    for ds, entry in upcoming:
        new = apply_run_adaptation(entry, factor)
        if new["target_distance_m"] != entry.get("target_distance_m"):
            await update_run_plan_entry(user_id, ds, {
                "target_distance_m":   new["target_distance_m"],
                "target_duration_min": new["target_duration_min"],
            })
            adjusted += 1

    if upcoming:
        await _broadcast(user_id, {
            "type":    "run_adaptation_feedback",
            "status":  status,
            "message": message,
            "entries_adjusted": adjusted,
        })
        if post_as_coach_message:
            await _post_coach_text(user_id, coach_engine.compose_message(
                "adaptation_result", {"status": status, "message": message, "factor": factor},
            ))
    if adjusted:
        run_plan = await get_run_plan(user_id)
        await _broadcast(user_id, {"type": "run_plan_updated", "run_plan": run_plan})


# One sync per user at a time, throttled to every 10 minutes
_strava_sync_at: dict[str, float] = {}


async def _strava_sync_task(user_id: str):
    """Import new Strava activities as rides/runs, then re-run plan adaptation."""
    import time
    if time.monotonic() - _strava_sync_at.get(user_id, 0) < 600:
        return

    token = await _strava_fresh_token(user_id)
    if not token:
        return
    _strava_sync_at[user_id] = time.monotonic()

    rides_all = await get_rides(user_id)
    known_ride_ids = {r.get("strava_id") for r in rides_all if r.get("strava_id")}
    ftp = next((r.get("ftp") for r in rides_all if r.get("ftp")), 250)

    runs_all = await get_runs(user_id)
    known_run_ids = {r.get("strava_id") for r in runs_all if r.get("strava_id")}

    after = int((datetime.now(timezone.utc) - timedelta(days=60)).timestamp())
    acts  = await strava.list_activities(token, after)

    imported_rides = imported_runs = 0
    for act in acts:
        if strava.is_bike(act) and act.get("id") not in known_ride_ids:
            await save_ride(user_id, strava.activity_to_ride(act, ftp))
            imported_rides += 1
        elif strava.is_run(act) and act.get("id") not in known_run_ids:
            await save_run(user_id, strava.activity_to_run(act))
            imported_runs += 1

    if imported_rides:
        log.info("Strava import: user=%s  rides=%d", user_id, imported_rides)
        rides = await get_rides(user_id)
        await _broadcast(user_id, {"type": "history_updated", "rides": rides})
        await _broadcast(user_id, {
            "type":    "strava_imported",
            "count":   imported_rides,
            "message": f"Imported {imported_rides} ride{'s' if imported_rides != 1 else ''} from Strava",
        })
        await _run_adaptation(user_id, post_as_coach_message=True)
        await _queue_checkin_if_idle(user_id)

    if imported_runs:
        log.info("Strava import: user=%s  runs=%d", user_id, imported_runs)
        runs = await get_runs(user_id)
        await _broadcast(user_id, {"type": "runs_updated", "runs": runs})
        await _broadcast(user_id, {
            "type":    "run_imported",
            "count":   imported_runs,
            "message": f"Imported {imported_runs} run{'s' if imported_runs != 1 else ''} from Strava",
        })
        await _run_run_adaptation(user_id, post_as_coach_message=True)
        await _queue_checkin_if_idle(user_id)


async def _broadcast_strava_status(user_id: str):
    conn = await get_strava_connection(user_id) if strava.enabled() else None
    await _broadcast(user_id, {
        "type":         "strava_status",
        "configured":   strava.enabled(),
        "connected":    bool(conn),
        "athlete_name": (conn or {}).get("athlete_name", ""),
    })


# ── Coach chat ──────────────────────────────────────────────────────────
# Onboarding survey + post-workout check-ins, driven entirely by
# coach_engine's rule-based state machine. Conversation state lives in the
# coach_messages transcript itself (each open quick_reply/number_input/
# free_text row carries the in-progress profile answers in its payload) —
# no separate "session" table needed.

async def _post_coach_row(user_id: str, role: str, text: str,
                           message_type: str = "plain", payload: dict | None = None):
    row = await save_coach_message(user_id, role, text, message_type, payload)
    await _broadcast(user_id, {"type": "coach_message", "message": row})
    return row


async def _post_coach_text(user_id: str, text: str):
    """Plain coach bubble — used for adaptation-result messages."""
    if text:
        await _post_coach_row(user_id, "coach", text)


async def _post_coach_step(user_id: str, step: str, profile_so_far: dict):
    prompt = coach_engine.step_prompt(step, profile_so_far)
    prompt["payload"]["profile_so_far"] = profile_so_far
    await _post_coach_row(user_id, "coach", prompt["text"], prompt["message_type"], prompt["payload"])


async def _get_pending_coach_step(user_id: str) -> Optional[dict]:
    """The most recent coach message, if it's still awaiting a reply."""
    messages = await get_coach_messages(user_id, limit=5)
    if not messages:
        return None
    last = messages[-1]
    if last["role"] == "coach" and last["message_type"] in ("quick_reply", "number_input", "free_text"):
        return last
    return None


def _label_for_reply(pending: dict, value: str) -> str:
    if pending["message_type"] == "quick_reply":
        opts = pending["payload"].get("options", [])
        match = next((o for o in opts if o["value"] == value), None)
        if match:
            return match["label"]
    return str(value)


async def _seed_onboarding_if_new(user_id: str):
    """Start the onboarding conversation on a brand-new user's first connect."""
    profile, messages = await asyncio.gather(get_athlete_profile(user_id), get_coach_messages(user_id, limit=1))
    if profile or messages:
        return
    await _post_coach_step(user_id, "discipline", {})


async def _do_generate_plan(user_id: str, profile: dict) -> int:
    """Generate (and replace) the user's cycling plan. Returns sessions created."""
    sessions = generate_plan(
        goal          = profile.get("goal", "base_fitness"),
        level         = profile.get("level", "intermediate"),
        days_per_week = int(profile.get("days_per_week", 4)),
        session_mins  = int(profile.get("session_mins", 60)),
    )
    await clear_generated_plan(user_id)
    n = await save_generated_plan(user_id, sessions)
    log.info("Plan generated: user=%s  sessions=%d  goal=%s", user_id, n, profile.get("goal"))

    workouts, plan = await asyncio.gather(get_workouts(user_id), get_plan(user_id))
    await _broadcast(user_id, {
        "type":             "plan_generated",
        "sessions_created": n,
        "weeks":            6,
        "goal":             profile.get("goal", "base_fitness"),
        "ftp":              int(profile.get("ftp", 0)) or None,
        "message":          f"Your 6-week plan is ready — {n} sessions scheduled.",
    })
    await _broadcast(user_id, {"type": "workouts_updated", "workouts": workouts})
    await _broadcast(user_id, {"type": "plan_updated", "plan": plan})
    return n


async def _do_generate_run_plan(user_id: str, profile: dict) -> int:
    """Generate (and replace) the user's run plan. Returns sessions created."""
    runs_all = await get_runs(user_id)
    paces    = [r["avg_pace_sec_per_km"] for r in runs_all if r.get("avg_pace_sec_per_km")]
    avg_pace = sum(paces) / len(paces) if paces else 375.0

    weekly_target_m = float(profile.get("weekly_miles", 15)) * 1609.34
    sessions = generate_run_plan(
        goal                = profile.get("goal", "base_mileage"),
        level               = profile.get("level", "intermediate"),
        days_per_week       = int(profile.get("days_per_week", 4)),
        weekly_target_m     = weekly_target_m,
        avg_pace_sec_per_km = avg_pace,
    )
    await clear_run_plan(user_id)
    n = await save_run_plan(user_id, sessions)
    log.info("Run plan generated: user=%s  sessions=%d  goal=%s", user_id, n, profile.get("goal"))

    run_plan = await get_run_plan(user_id)
    await _broadcast(user_id, {
        "type":             "run_plan_generated",
        "sessions_created": n,
        "weeks":            6,
        "goal":             profile.get("goal", "base_mileage"),
        "message":          f"Your 6-week run plan is ready — {n} runs scheduled.",
    })
    await _broadcast(user_id, {"type": "run_plan_updated", "run_plan": run_plan})
    return n


async def _finish_onboarding(user_id: str, profile_so_far: dict):
    discipline = profile_so_far.get("discipline", "both")
    fields: dict = {}

    if discipline in ("cycling", "both") and profile_so_far.get("bike_goal"):
        days  = int(profile_so_far.get("bike_days", 4))
        hours = float(profile_so_far.get("bike_hours", 5))
        fields.update({
            "bike_style":         profile_so_far.get("bike_style", "road"),
            "bike_goal":          profile_so_far.get("bike_goal"),
            "bike_level":         profile_so_far.get("bike_level", "intermediate"),
            "bike_days_per_week": days,
            "bike_weekly_hours":  hours,
            "bike_ftp":           int(float(profile_so_far["bike_ftp"])) if profile_so_far.get("bike_ftp") else None,
        })

    if discipline in ("running", "both") and profile_so_far.get("run_goal"):
        fields.update({
            "run_style":         profile_so_far.get("run_style", "road"),
            "run_goal":          profile_so_far.get("run_goal"),
            "run_level":         profile_so_far.get("run_level", "intermediate"),
            "run_days_per_week": int(profile_so_far.get("run_days", 4)),
            "run_weekly_miles":  float(profile_so_far.get("run_miles", 15)),
        })

    notes = (profile_so_far.get("notes") or "").strip()
    if notes and notes.lower() != "skip":
        fields["notes"] = notes

    fields["onboarded_at"] = datetime.now(timezone.utc).isoformat()
    await save_athlete_profile(user_id, fields)

    summary_bits = []
    if fields.get("bike_goal"):
        days  = fields["bike_days_per_week"]
        hours = fields["bike_weekly_hours"]
        n = await _do_generate_plan(user_id, {
            "goal":          fields["bike_goal"],
            "level":         fields["bike_level"],
            "days_per_week": days,
            "session_mins":  round((hours * 60) / max(days, 1)),
            "ftp":           fields.get("bike_ftp"),
        })
        bike_label = "mountain biking" if fields["bike_style"] == "mountain" else "cycling"
        summary_bits.append(f"{n} {bike_label} sessions")

    if fields.get("run_goal"):
        n = await _do_generate_run_plan(user_id, {
            "goal":          fields["run_goal"],
            "level":         fields["run_level"],
            "days_per_week": fields["run_days_per_week"],
            "weekly_miles":  fields["run_weekly_miles"],
        })
        run_label = "trail runs" if fields["run_style"] == "trail" else "runs"
        summary_bits.append(f"{n} {run_label}")

    text = "Your 6-week plan is ready" + (f" — {', '.join(summary_bits)} scheduled. "
           "I'll check in with you after every workout and adjust things as we go." if summary_bits
           else ". Come back and tell me how each workout goes, and I'll adjust as we go.")
    await _post_coach_row(user_id, "coach", text, "plan_summary")


async def _handle_coach_reply(user_id: str, step: str, value: str):
    pending = await _get_pending_coach_step(user_id)
    if not pending or pending["payload"].get("step") != step:
        return   # stale or duplicate reply — ignore

    profile_so_far = dict(pending["payload"].get("profile_so_far", {}))

    label = _label_for_reply(pending, value)
    await _post_coach_row(user_id, "user", label, "plain", {"step": step, "value": value})

    if step == "confirm":
        if value == "restart":
            await _post_coach_step(user_id, "discipline", {})
        else:
            await _finish_onboarding(user_id, profile_so_far)
        return

    profile_so_far[step] = value
    discipline = profile_so_far.get("discipline", "both")
    nxt = coach_engine.next_step(discipline, step) or "confirm"
    await _post_coach_step(user_id, nxt, profile_so_far)


async def _queue_checkin_if_idle(user_id: str):
    """Post the oldest queued check-in, unless the chat already has an open prompt."""
    if await _get_pending_coach_step(user_id):
        return

    profile = await get_athlete_profile(user_id)
    since   = (profile or {}).get("onboarded_at")
    if not since:
        return   # coach relationship hasn't started yet — no retroactive check-ins

    rides_needing = await get_rides_needing_checkin(user_id, since=since, limit=1)
    if rides_needing:
        r = rides_needing[0]
        prompt = coach_engine.checkin_prompt("ride", r.get("workout_name") or "your ride")
        prompt["payload"]["activity_id"] = r["id"]
        await _post_coach_row(user_id, "coach", prompt["text"], prompt["message_type"], prompt["payload"])
        return

    runs_needing = await get_runs_needing_checkin(user_id, since=since, limit=1)
    if runs_needing:
        r = runs_needing[0]
        prompt = coach_engine.checkin_prompt("run", r.get("name") or "your run")
        prompt["payload"]["activity_id"] = r["id"]
        await _post_coach_row(user_id, "coach", prompt["text"], prompt["message_type"], prompt["payload"])


async def _handle_coach_checkin_reply(user_id: str, kind: str, activity_id: str, feedback: str):
    pending = await _get_pending_coach_step(user_id)
    if not pending or pending["payload"].get("kind") != kind or pending["payload"].get("activity_id") != activity_id:
        return   # stale or duplicate reply — ignore

    label = next((o["label"] for o in coach_engine.CHECKIN_OPTIONS if o["value"] == feedback), feedback)
    await _post_coach_row(user_id, "user", label, "plain", {"kind": kind, "activity_id": activity_id, "feedback": feedback})

    if kind == "ride":
        await set_ride_feedback(activity_id, feedback)
        await _run_adaptation(user_id, post_as_coach_message=True)
    else:
        await set_run_feedback(activity_id, feedback)
        await _run_run_adaptation(user_id, post_as_coach_message=True)

    await _queue_checkin_if_idle(user_id)


async def _handle_coach_start_onboarding(user_id: str):
    await _post_coach_step(user_id, "discipline", {})


# ── Broadcast ─────────────────────────────────────────────────────────

async def _broadcast(user_id: str, msg: dict):
    import json

    if msg.get("type") == "save_ride":
        ride_data = msg.get("ride", {})
        if ride_data:
            saved = await save_ride(user_id, ride_data)
            log.info(
                "Ride saved  user=%s  elapsed=%.0fs  NP=%.0fW  TSS=%.1f",
                user_id,
                ride_data.get("elapsed", 0),
                ride_data.get("normalized_power", 0),
                ride_data.get("tss", 0),
            )

            # ── Adaptive plan adjustment ──────────────────────────────────
            rides_all = await get_rides(user_id)
            await _broadcast(user_id, {"type": "history_updated", "rides": rides_all})
            await _run_adaptation(user_id, post_as_coach_message=True)
            await _queue_checkin_if_idle(user_id)

            # ── Strava auto-upload (background) ──────────────────────────
            if strava.enabled() and saved:
                asyncio.create_task(
                    _strava_upload_task(user_id, saved["id"], ride_data)
                )
        return

    if msg.get("type") == "live_data" and user_id in _engines and "power" in msg:
        _engines[user_id].record_power(msg["power"])

    payload = json.dumps(msg)
    dead: set[WebSocket] = set()
    for ws in list(_sockets.get(user_id, set())):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    _sockets.get(user_id, set()).difference_update(dead)


# ── WebSocket ─────────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = Query(default=None)):
    user_id = verify_token(token) if token else None
    if not user_id:
        await ws.close(code=4001)
        return

    await ws.accept()
    _sockets.setdefault(user_id, set()).add(ws)
    log.info("WS connected: user=%s", user_id)

    await _seed_onboarding_if_new(user_id)

    workouts, rides, plan, runs, run_plan, profile, coach_messages = await asyncio.gather(
        get_workouts(user_id),
        get_rides(user_id),
        get_plan(user_id),
        get_runs(user_id),
        get_run_plan(user_id),
        get_athlete_profile(user_id),
        get_coach_messages(user_id),
    )

    import json
    await ws.send_text(json.dumps({
        "type":           "init",
        "workouts":       workouts,
        "rides":          rides,
        "plan":           plan,
        "runs":           runs,
        "run_plan":       run_plan,
        "profile":        profile,
        "coach_messages": coach_messages,
        **ble.get_status(),
    }))

    # Pull any new Strava activities in the background
    if strava.enabled():
        asyncio.create_task(_strava_sync_task(user_id))

    try:
        while True:
            raw = await ws.receive_text()
            await _handle(user_id, json.loads(raw))
    except WebSocketDisconnect:
        _sockets.get(user_id, set()).discard(ws)
        log.info("WS disconnected: user=%s", user_id)
    except Exception as exc:
        log.warning("WS error: %s", exc)
        _sockets.get(user_id, set()).discard(ws)


# ── Message handler ───────────────────────────────────────────────────

async def _handle(user_id: str, msg: dict):
    action = msg.get("action")

    # ── BLE ──
    if action == "scan":
        asyncio.create_task(_scan(user_id))

    elif action == "connect":
        asyncio.create_task(_connect(user_id, msg["device_id"], msg.get("role", "trainer")))

    elif action == "disconnect":
        await ble.disconnect_all()
        await _broadcast(user_id, {"type": "device_status", **ble.get_status()})

    # ── Workout lifecycle ──
    elif action == "start_workout":
        workouts = await get_workouts(user_id)
        workout  = next((w for w in workouts if w["id"] == msg["workout_id"]), None)
        if not workout:
            await _broadcast(user_id, {"type": "error", "message": "Workout not found"})
            return

        ftp      = int(msg.get("ftp", 250))
        simulate = bool(msg.get("simulate", False))

        if user_id in _engines:
            await _engines[user_id].stop()

        engine = WorkoutEngine(
            workout=workout,
            ftp=ftp,
            trainer=ble,
            broadcast=lambda m: asyncio.create_task(_broadcast(user_id, m)),
            simulate=simulate,
        )
        _engines[user_id] = engine
        asyncio.create_task(engine.run())

    elif action == "pause" and user_id in _engines:
        await _engines[user_id].pause()

    elif action == "resume" and user_id in _engines:
        await _engines[user_id].resume()

    elif action == "stop" and user_id in _engines:
        await _engines[user_id].stop()
        del _engines[user_id]

    elif action == "skip_interval" and user_id in _engines:
        await _engines[user_id].skip_interval()

    elif action == "adjust_power" and user_id in _engines:
        _engines[user_id].power_offset += int(msg.get("offset", 0))
        await _engines[user_id]._push_power()

    # ── Workout CRUD ──
    elif action == "save_workout":
        row = await save_workout(user_id, msg["workout"])
        workouts = await get_workouts(user_id)
        await _broadcast(user_id, {
            "type":      "workouts_updated",
            "workouts":  workouts,
            "saved_id":  row["id"],
        })

    elif action == "delete_workout":
        await delete_workout(user_id, msg["workout_id"])
        workouts = await get_workouts(user_id)
        await _broadcast(user_id, {"type": "workouts_updated", "workouts": workouts})

    # ── Ride history ──
    elif action == "get_history":
        rides = await get_rides(user_id)
        await _broadcast(user_id, {"type": "history_updated", "rides": rides})

    elif action == "delete_ride":
        await delete_ride(user_id, msg["ride_id"])
        rides = await get_rides(user_id)
        await _broadcast(user_id, {"type": "history_updated", "rides": rides})

    # ── Calendar plan ──
    elif action == "plan_day":
        date_str   = msg.get("date", "")
        workout_id = msg.get("workout_id") or None
        if date_str:
            await set_plan_day(user_id, date_str, workout_id)
            plan = await get_plan(user_id)
            await _broadcast(user_id, {"type": "plan_updated", "plan": plan})

    elif action == "get_plan":
        plan = await get_plan(user_id)
        await _broadcast(user_id, {"type": "plan_updated", "plan": plan})

    # ── Adaptive plan generation ──
    # ── Coach chat ──
    elif action == "coach_reply":
        await _handle_coach_reply(user_id, msg.get("step", ""), msg.get("value", ""))

    elif action == "coach_checkin_reply":
        await _handle_coach_checkin_reply(
            user_id, msg.get("kind", ""), msg.get("activity_id", ""), msg.get("feedback", ""),
        )

    elif action == "coach_start_onboarding":
        await _handle_coach_start_onboarding(user_id)

    # ── Run history ──
    elif action == "get_runs":
        runs = await get_runs(user_id)
        await _broadcast(user_id, {"type": "runs_updated", "runs": runs})

    elif action == "delete_run":
        await delete_run(user_id, msg["run_id"])
        runs = await get_runs(user_id)
        await _broadcast(user_id, {"type": "runs_updated", "runs": runs})

    # ── Run plan (manual single-day edit) ──
    elif action == "run_plan_day":
        date_str = msg.get("date", "")
        entry    = msg.get("entry") or None
        if date_str:
            await set_run_plan_day(user_id, date_str, entry)
            run_plan = await get_run_plan(user_id)
            await _broadcast(user_id, {"type": "run_plan_updated", "run_plan": run_plan})

    elif action == "get_run_plan":
        run_plan = await get_run_plan(user_id)
        await _broadcast(user_id, {"type": "run_plan_updated", "run_plan": run_plan})

    # ── Strava ──
    elif action == "strava_status":
        await _broadcast_strava_status(user_id)

    elif action == "strava_disconnect":
        conn = await get_strava_connection(user_id)
        if conn:
            await strava.deauthorize(conn["access_token"])
            await delete_strava_connection(user_id)
        await _broadcast_strava_status(user_id)


# ── BLE tasks ─────────────────────────────────────────────────────────

async def _scan(user_id: str):
    await _broadcast(user_id, {"type": "scanning", "scanning": True})
    devices = await ble.scan(duration=10)
    await _broadcast(user_id, {"type": "scan_results", "devices": devices, "scanning": False})


async def _connect(user_id: str, device_id: str, role: str):
    await _broadcast(user_id, {"type": "connecting", "device_id": device_id, "role": role})
    ok = await ble.connect(device_id, role)
    if ok:
        asyncio.create_task(
            ble.start_notifications(lambda m: asyncio.create_task(_broadcast(user_id, m)))
        )
    await _broadcast(user_id, {"type": "device_status", "connect_success": ok, **ble.get_status()})


# ── Static files + entry ──────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


def _open_browser():
    import time
    time.sleep(1.2)
    webbrowser.open("http://localhost:8765")


if __name__ == "__main__":
    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
