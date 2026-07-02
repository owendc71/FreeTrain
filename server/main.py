"""FreeTrain – FastAPI server with Supabase auth + data, BLE backend."""
import asyncio
import logging
import threading
import webbrowser

import uvicorn
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from ble_manager import BLEManager
from plan_engine import apply_adaptation, compute_adaptation, generate_plan
from supabase_client import (
    SUPABASE_ANON_KEY, SUPABASE_URL,
    clear_generated_plan, delete_ride, delete_workout,
    get_plan, get_rides, get_upcoming_generated_workouts, get_workouts,
    save_generated_plan, save_ride, save_workout, set_plan_day,
    update_workout_intervals, verify_token,
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
        f'  supabaseAnonKey: "{SUPABASE_ANON_KEY}"\n'
        f"}};\n"
    )
    return Response(content=js, media_type="application/javascript")


# ── Broadcast ─────────────────────────────────────────────────────────

async def _broadcast(user_id: str, msg: dict):
    import json

    if msg.get("type") == "save_ride":
        ride_data = msg.get("ride", {})
        if ride_data:
            await save_ride(user_id, ride_data)
            log.info(
                "Ride saved  user=%s  elapsed=%.0fs  NP=%.0fW  TSS=%.1f",
                user_id,
                ride_data.get("elapsed", 0),
                ride_data.get("normalized_power", 0),
                ride_data.get("tss", 0),
            )

            # ── Adaptive plan adjustment ──────────────────────────────────
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
                    "type":               "adaptation_feedback",
                    "status":             status,
                    "message":            message,
                    "workouts_adjusted":  adjusted,
                })

            await _broadcast(user_id, {"type": "history_updated", "rides": rides_all})
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

    workouts, rides, plan = await asyncio.gather(
        get_workouts(user_id),
        get_rides(user_id),
        get_plan(user_id),
    )

    import json
    await ws.send_text(json.dumps({
        "type":     "init",
        "workouts": workouts,
        "rides":    rides,
        "plan":     plan,
        **ble.get_status(),
    }))

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
    elif action == "generate_plan":
        profile = msg.get("profile", {})
        sessions = generate_plan(
            goal         = profile.get("goal", "base_fitness"),
            level        = profile.get("level", "intermediate"),
            days_per_week = int(profile.get("days_per_week", 4)),
            session_mins = int(profile.get("session_mins", 60)),
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

    elif action == "clear_plan":
        await clear_generated_plan(user_id)
        workouts, plan = await asyncio.gather(get_workouts(user_id), get_plan(user_id))
        await _broadcast(user_id, {"type": "workouts_updated", "workouts": workouts})
        await _broadcast(user_id, {"type": "plan_updated", "plan": plan})
        await _broadcast(user_id, {"type": "plan_cleared"})


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
