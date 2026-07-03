"""Strava integration: OAuth token exchange, TCX generation, activity upload."""
import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx

log = logging.getLogger(__name__)

STRAVA_CLIENT_ID     = os.environ.get("STRAVA_CLIENT_ID", "")
STRAVA_CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")

_TOKEN_URL  = "https://www.strava.com/oauth/token"
_DEAUTH_URL = "https://www.strava.com/oauth/deauthorize"
_API        = "https://www.strava.com/api/v3"


def enabled() -> bool:
    return bool(STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET)


# ── OAuth ──────────────────────────────────────────────────────────

async def exchange_code(code: str) -> dict:
    """Exchange an authorization code for tokens. Returns token dict or raises."""
    async with httpx.AsyncClient() as client:
        r = await client.post(_TOKEN_URL, data={
            "client_id":     STRAVA_CLIENT_ID,
            "client_secret": STRAVA_CLIENT_SECRET,
            "code":          code,
            "grant_type":    "authorization_code",
        })
        r.raise_for_status()
        return r.json()


async def refresh_tokens(refresh_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(_TOKEN_URL, data={
            "client_id":     STRAVA_CLIENT_ID,
            "client_secret": STRAVA_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type":    "refresh_token",
        })
        r.raise_for_status()
        return r.json()


async def deauthorize(access_token: str):
    """Best-effort revoke on Strava's side."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(_DEAUTH_URL, params={"access_token": access_token})
    except Exception:
        pass


# ── TCX generation ─────────────────────────────────────────────────

def build_tcx(start: datetime, power_samples: list, name: str) -> str:
    """Build a TCX file from 1-second power samples (indoor ride, no GPS)."""
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    start = start.astimezone(timezone.utc)

    def ts(sec: int) -> str:
        return (start + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%SZ")

    points = []
    for i, w in enumerate(power_samples):
        points.append(
            f"<Trackpoint><Time>{ts(i)}</Time>"
            f"<Extensions><ns3:TPX><ns3:Watts>{max(0, int(w))}</ns3:Watts></ns3:TPX></Extensions>"
            f"</Trackpoint>"
        )

    total = len(power_samples)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<TrainingCenterDatabase'
        ' xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"'
        ' xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">'
        '<Activities><Activity Sport="Biking">'
        f'<Id>{ts(0)}</Id>'
        f'<Lap StartTime="{ts(0)}">'
        f'<TotalTimeSeconds>{total}</TotalTimeSeconds>'
        '<DistanceMeters>0</DistanceMeters>'
        '<Calories>0</Calories>'
        '<Intensity>Active</Intensity>'
        '<TriggerMethod>Manual</TriggerMethod>'
        f'<Track>{"".join(points)}</Track>'
        '</Lap>'
        f'<Notes>{name}</Notes>'
        '</Activity></Activities>'
        '</TrainingCenterDatabase>'
    )


# ── Upload ─────────────────────────────────────────────────────────

async def upload_activity(access_token: str, tcx: str, name: str) -> int | None:
    """Upload a TCX to Strava and poll until processed. Returns activity_id or None."""
    headers = {"Authorization": f"Bearer {access_token}"}

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{_API}/uploads",
            headers=headers,
            data={
                "name":        name,
                "data_type":   "tcx",
                "trainer":     "1",
                "description": "Recorded with FreeTrain",
            },
            files={"file": ("ride.tcx", tcx.encode(), "application/xml")},
        )
        if r.status_code >= 400:
            log.warning("Strava upload rejected: %s", r.text[:300])
            return None
        upload_id = r.json().get("id")

        # Poll for processing to finish
        for _ in range(15):
            await asyncio.sleep(2)
            s = await client.get(f"{_API}/uploads/{upload_id}", headers=headers)
            if s.status_code >= 400:
                return None
            body = s.json()
            if body.get("activity_id"):
                return body["activity_id"]
            if body.get("error"):
                log.warning("Strava processing error: %s", body["error"])
                return None
    return None
