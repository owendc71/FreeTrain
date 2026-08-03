"""Supabase client, JWT verification, and async data helpers."""
import asyncio
import os
from typing import Optional

from jose import JWTError, jwt
from supabase import Client, create_client

# ── Env vars (all required) ────────────────────────────────────────
SUPABASE_URL         = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]   # server-only, never sent to browser
SUPABASE_JWT_SECRET  = os.environ["SUPABASE_JWT_SECRET"]    # Settings → API → JWT Settings
SUPABASE_ANON_KEY    = os.environ["SUPABASE_ANON_KEY"]      # safe to expose to browser

# Service-role client bypasses RLS; we enforce user-scoping in every query.
db: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# ── Auth ───────────────────────────────────────────────────────────

def verify_token(token: str) -> Optional[str]:
    """Decode a Supabase JWT. Returns user_id (sub) or None."""
    try:
        payload = jwt.decode(
            token,
            SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        return payload.get("sub")
    except JWTError:
        return None


# ── Async helpers (sync supabase-py wrapped in asyncio.to_thread) ──
# Keeps FastAPI WebSocket handlers non-blocking without managing an
# async client at startup.

async def _run(fn):
    return await asyncio.to_thread(fn)


# ── Workouts ───────────────────────────────────────────────────────

async def get_workouts(user_id: str) -> list[dict]:
    r = await _run(lambda: db.table("workouts")
                              .select("*")
                              .eq("user_id", user_id)
                              .execute())
    return r.data or []


async def save_workout(user_id: str, data: dict) -> dict:
    intervals  = data.get("intervals", [])
    total_dur  = sum(iv["duration"] for iv in intervals)
    payload = {
        "user_id":        user_id,
        "name":           data["name"],
        "description":    data.get("description", ""),
        "intervals":      intervals,
        "total_duration": total_dur,
    }
    wid = data.get("id")
    if wid:
        r = await _run(lambda: db.table("workouts").update(payload)
                                  .eq("id", wid).eq("user_id", user_id).execute())
        if r.data:
            return r.data[0]
    r = await _run(lambda: db.table("workouts").insert(payload).execute())
    return r.data[0]


async def delete_workout(user_id: str, workout_id: str):
    await _run(lambda: db.table("workouts").delete()
                          .eq("id", workout_id).eq("user_id", user_id).execute())


# ── Rides ──────────────────────────────────────────────────────────

_RIDE_COLS = ("id,workout_name,date,elapsed,total_duration,"
              "avg_power,normalized_power,intensity_factor,tss,ftp,completed,strava_id,source,feedback")


async def get_rides(user_id: str) -> list[dict]:
    r = await _run(lambda: db.table("rides")
                              .select(_RIDE_COLS)
                              .eq("user_id", user_id)
                              .order("created_at", desc=True)
                              .execute())
    return r.data or []


async def save_ride(user_id: str, ride: dict):
    payload = {
        "user_id":          user_id,
        "workout_name":     ride.get("workout_name", ""),
        "date":             ride.get("date", ""),
        "elapsed":          ride.get("elapsed", 0),
        "total_duration":   ride.get("total_duration", 0),
        "avg_power":        ride.get("avg_power", 0.0),
        "normalized_power": ride.get("normalized_power", 0.0),
        "intensity_factor": ride.get("intensity_factor", 0.0),
        "tss":              ride.get("tss", 0.0),
        "ftp":              ride.get("ftp", 250),
        "completed":        ride.get("completed", False),
        "power_samples":    ride.get("power_samples", []),
        "source":           ride.get("source", "freetrain"),
    }
    if ride.get("strava_id"):
        payload["strava_id"] = ride["strava_id"]
    r = await _run(lambda: db.table("rides").insert(payload).execute())
    return r.data[0] if r.data else None


async def delete_ride(user_id: str, ride_id: str):
    await _run(lambda: db.table("rides").delete()
                          .eq("id", ride_id).eq("user_id", user_id).execute())


# ── Plan ───────────────────────────────────────────────────────────

async def get_plan(user_id: str) -> dict:
    r = await _run(lambda: db.table("plans")
                              .select("date,workout_id")
                              .eq("user_id", user_id)
                              .execute())
    return {row["date"]: row["workout_id"]
            for row in (r.data or []) if row.get("workout_id")}


# ── Generated-plan management ──────────────────────────────────────

async def clear_generated_plan(user_id: str):
    """Delete all FreeTrain-generated workouts (and their plan entries via cascade)."""
    r = await _run(lambda: db.table("workouts")
                              .select("id")
                              .eq("user_id", user_id)
                              .like("name", "FreeTrain · %")
                              .execute())
    ids = [w["id"] for w in (r.data or [])]
    if ids:
        # Remove plan entries that point to generated workouts
        for wid in ids:
            await _run(lambda w=wid: db.table("plans").delete()
                                        .eq("user_id", user_id)
                                        .eq("workout_id", w)
                                        .execute())
        # Remove the workouts themselves
        await _run(lambda: db.table("workouts").delete()
                              .eq("user_id", user_id)
                              .like("name", "FreeTrain · %")
                              .execute())


async def save_generated_plan(
    user_id: str,
    sessions: list[tuple[str, dict]],
) -> int:
    """Save a list of (date_iso, workout_dict) pairs. Returns number of sessions saved."""
    for date_str, workout in sessions:
        r = await _run(lambda w=workout: db.table("workouts").insert({
            "user_id":        user_id,
            "name":           w["name"],
            "description":    w.get("description", ""),
            "intervals":      w["intervals"],
            "total_duration": sum(iv["duration"] for iv in w["intervals"]),
        }).execute())
        if r.data:
            wid = r.data[0]["id"]
            await _run(lambda d=date_str, w=wid: db.table("plans").insert({
                "user_id":    user_id,
                "date":       d,
                "workout_id": w,
            }).execute())
    return len(sessions)


async def get_upcoming_generated_workouts(user_id: str, limit: int = 3) -> list[dict]:
    """Return the next N planned generated workouts for adaptation adjustment."""
    today = date.today().isoformat() if True else ""  # evaluated at call time
    from datetime import date as _date
    today = _date.today().isoformat()

    plan_r = await _run(lambda: db.table("plans")
                                    .select("date,workout_id")
                                    .eq("user_id", user_id)
                                    .gte("date", today)
                                    .order("date")
                                    .limit(limit * 2)
                                    .execute())
    entries = plan_r.data or []
    if not entries:
        return []

    wids = [e["workout_id"] for e in entries if e.get("workout_id")]
    if not wids:
        return []

    wk_r = await _run(lambda: db.table("workouts")
                                   .select("*")
                                   .in_("id", wids)
                                   .like("name", "FreeTrain · %")
                                   .execute())
    generated = {w["id"]: w for w in (wk_r.data or [])}

    result = []
    for e in entries:
        w = generated.get(e.get("workout_id"))
        if w:
            result.append({"date": e["date"], "workout": w})
        if len(result) >= limit:
            break
    return result


async def update_workout_intervals(workout_id: str, intervals: list[dict]):
    """Overwrite the intervals of a workout (used for adaptive adjustment)."""
    await _run(lambda: db.table("workouts")
                          .update({"intervals": intervals})
                          .eq("id", workout_id)
                          .execute())


# ── Runs ───────────────────────────────────────────────────────────

_RUN_COLS = ("id,name,date,elapsed,distance_m,elevation_gain_m,"
             "avg_pace_sec_per_km,completed,source,strava_id,feedback")


async def get_runs(user_id: str) -> list[dict]:
    r = await _run(lambda: db.table("runs")
                              .select(_RUN_COLS)
                              .eq("user_id", user_id)
                              .order("date", desc=True)
                              .execute())
    return r.data or []


async def save_run(user_id: str, run: dict) -> Optional[dict]:
    payload = {
        "user_id":             user_id,
        "name":                run.get("name", ""),
        "date":                run.get("date", ""),
        "elapsed":             run.get("elapsed", 0),
        "distance_m":          run.get("distance_m", 0),
        "elevation_gain_m":    run.get("elevation_gain_m", 0),
        "avg_pace_sec_per_km": run.get("avg_pace_sec_per_km", 0),
        "completed":           run.get("completed", True),
        "source":              run.get("source", "strava"),
    }
    if run.get("strava_id"):
        payload["strava_id"] = run["strava_id"]
    r = await _run(lambda: db.table("runs").insert(payload).execute())
    return r.data[0] if r.data else None


async def delete_run(user_id: str, run_id: str):
    await _run(lambda: db.table("runs").delete()
                          .eq("id", run_id).eq("user_id", user_id).execute())


# ── Run plan ───────────────────────────────────────────────────────

async def get_run_plan(user_id: str) -> dict:
    """Returns {date: entry_dict} for every scheduled run day."""
    r = await _run(lambda: db.table("run_plan_entries")
                              .select("*")
                              .eq("user_id", user_id)
                              .execute())
    return {row["date"]: row for row in (r.data or [])}


async def clear_run_plan(user_id: str):
    await _run(lambda: db.table("run_plan_entries").delete()
                          .eq("user_id", user_id).execute())


async def save_run_plan(user_id: str, entries: list[tuple[str, dict]]) -> int:
    """Save a list of (date_iso, entry_dict) pairs. Returns number saved."""
    for date_str, e in entries:
        await _run(lambda d=date_str, ent=e: db.table("run_plan_entries").upsert({
            "user_id":             user_id,
            "date":                d,
            "run_type":            ent["run_type"],
            "target_distance_m":   ent.get("target_distance_m", 0),
            "target_duration_min": ent.get("target_duration_min", 0),
            "description":         ent.get("description", ""),
        }, on_conflict="user_id,date").execute())
    return len(entries)


async def update_run_plan_entry(user_id: str, date_str: str, updates: dict):
    await _run(lambda: db.table("run_plan_entries")
                          .update(updates)
                          .eq("user_id", user_id)
                          .eq("date", date_str)
                          .execute())


async def set_run_plan_day(user_id: str, date_str: str, entry: Optional[dict]):
    await _run(lambda: db.table("run_plan_entries").delete()
                          .eq("user_id", user_id).eq("date", date_str).execute())
    if entry:
        await _run(lambda: db.table("run_plan_entries").insert({
            "user_id":             user_id,
            "date":                date_str,
            "run_type":            entry["run_type"],
            "target_distance_m":   entry.get("target_distance_m", 0),
            "target_duration_min": entry.get("target_duration_min", 0),
            "description":         entry.get("description", ""),
        }).execute())


# ── Strava ─────────────────────────────────────────────────────────

async def get_strava_connection(user_id: str) -> Optional[dict]:
    r = await _run(lambda: db.table("strava_connections")
                              .select("*")
                              .eq("user_id", user_id)
                              .execute())
    return r.data[0] if r.data else None


async def save_strava_connection(user_id: str, tokens: dict):
    athlete = tokens.get("athlete") or {}
    name = f'{athlete.get("firstname", "")} {athlete.get("lastname", "")}'.strip()
    payload = {
        "user_id":       user_id,
        "athlete_id":    athlete.get("id"),
        "access_token":  tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_at":    tokens["expires_at"],
    }
    if name:
        payload["athlete_name"] = name
    await _run(lambda: db.table("strava_connections").upsert(payload).execute())


async def delete_strava_connection(user_id: str):
    await _run(lambda: db.table("strava_connections").delete()
                          .eq("user_id", user_id).execute())


async def set_ride_strava_id(ride_id: str, strava_id: int):
    await _run(lambda: db.table("rides")
                          .update({"strava_id": strava_id})
                          .eq("id", ride_id)
                          .execute())


async def set_plan_day(user_id: str, date_str: str, workout_id: Optional[str]):
    # Delete any existing entry for this day, then re-insert if needed.
    await _run(lambda: db.table("plans").delete()
                          .eq("user_id", user_id).eq("date", date_str).execute())
    if workout_id:
        await _run(lambda: db.table("plans").insert({
            "user_id":    user_id,
            "date":       date_str,
            "workout_id": workout_id,
        }).execute())


# ── Coach: athlete profile ───────────────────────────────────────────

async def get_athlete_profile(user_id: str) -> Optional[dict]:
    r = await _run(lambda: db.table("athlete_profiles")
                              .select("*")
                              .eq("user_id", user_id)
                              .execute())
    return r.data[0] if r.data else None


async def save_athlete_profile(user_id: str, fields: dict) -> dict:
    from datetime import datetime, timezone
    payload = {**fields, "user_id": user_id,
               "updated_at": datetime.now(timezone.utc).isoformat()}
    r = await _run(lambda: db.table("athlete_profiles")
                              .upsert(payload, on_conflict="user_id")
                              .execute())
    return r.data[0] if r.data else payload


# ── Coach: chat transcript ────────────────────────────────────────────

async def get_coach_messages(user_id: str, limit: int = 200) -> list[dict]:
    r = await _run(lambda: db.table("coach_messages")
                              .select("*")
                              .eq("user_id", user_id)
                              .order("created_at")
                              .limit(limit)
                              .execute())
    return r.data or []


async def get_latest_coach_message(user_id: str) -> Optional[dict]:
    """The single most recent coach_messages row, or None."""
    r = await _run(lambda: db.table("coach_messages")
                              .select("*")
                              .eq("user_id", user_id)
                              .order("created_at", desc=True)
                              .limit(1)
                              .execute())
    return r.data[0] if r.data else None


async def clear_coach_messages(user_id: str):
    await _run(lambda: db.table("coach_messages").delete()
                          .eq("user_id", user_id).execute())


async def save_coach_message(
    user_id: str, role: str, text: str,
    message_type: str = "plain", payload: Optional[dict] = None,
) -> dict:
    r = await _run(lambda: db.table("coach_messages").insert({
        "user_id":      user_id,
        "role":         role,
        "text":         text,
        "message_type": message_type,
        "payload":      payload or {},
    }).execute())
    return r.data[0] if r.data else {}


# ── Coach: subjective feedback + check-in queue ──────────────────────

async def set_ride_feedback(ride_id: str, feedback: str):
    await _run(lambda: db.table("rides")
                          .update({"feedback": feedback})
                          .eq("id", ride_id)
                          .execute())


async def set_run_feedback(run_id: str, feedback: str):
    await _run(lambda: db.table("runs")
                          .update({"feedback": feedback})
                          .eq("id", run_id)
                          .execute())


async def get_rides_needing_checkin(user_id: str, since: Optional[str] = None, limit: int = 5) -> list[dict]:
    """`since` (an ISO timestamp, typically athlete_profiles.onboarded_at) excludes the
    pre-existing ride backlog from before the coach relationship started."""
    def _q():
        q = (db.table("rides").select(_RIDE_COLS).eq("user_id", user_id)
               .eq("completed", True).is_("feedback", "null").order("created_at").limit(limit))
        if since:
            q = q.gte("created_at", since)
        return q.execute()
    r = await _run(_q)
    return r.data or []


async def get_runs_needing_checkin(user_id: str, since: Optional[str] = None, limit: int = 5) -> list[dict]:
    def _q():
        q = (db.table("runs").select(_RUN_COLS).eq("user_id", user_id)
               .is_("feedback", "null").order("created_at").limit(limit))
        if since:
            q = q.gte("created_at", since)
        return q.execute()
    r = await _run(_q)
    return r.data or []
