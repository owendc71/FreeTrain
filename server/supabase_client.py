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
              "avg_power,normalized_power,intensity_factor,tss,ftp,completed,strava_id")


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
    }
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
