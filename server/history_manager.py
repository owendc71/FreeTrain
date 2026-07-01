"""Ride history – save, list, and delete completed workouts."""
import json
from datetime import datetime
from pathlib import Path
from typing import Optional


# ── Power metrics ────────────────────────────────────────────────────────────

def calc_avg_power(samples: list[float]) -> float:
    return round(sum(samples) / len(samples), 1) if samples else 0.0


def calc_normalized_power(samples: list[float]) -> float:
    """
    Classic 30-second rolling-average → 4th-power mean → 4th root.
    Falls back to average if fewer than 30 samples.
    """
    if not samples:
        return 0.0
    if len(samples) < 30:
        return calc_avg_power(samples)
    rolling = [
        sum(samples[i : i + 30]) / 30
        for i in range(len(samples) - 29)
    ]
    mean4 = sum(r ** 4 for r in rolling) / len(rolling)
    return round(mean4 ** 0.25, 1)


def calc_tss(duration_sec: int, np: float, ftp: int) -> float:
    """Training Stress Score = (sec × NP × IF) / (FTP × 3600) × 100."""
    if ftp <= 0 or np <= 0:
        return 0.0
    intensity_factor = np / ftp
    return round((duration_sec * np * intensity_factor) / (ftp * 3600) * 100, 1)


def build_ride_summary(
    workout: dict,
    ftp: int,
    elapsed_sec: int,
    power_samples: list[float],
    completed: bool,
) -> dict:
    avg = calc_avg_power(power_samples)
    np  = calc_normalized_power(power_samples)
    tss = calc_tss(elapsed_sec, np, ftp)

    return {
        "id":              datetime.now().strftime("%Y%m%d-%H%M%S"),
        "date":            datetime.now().isoformat(timespec="seconds"),
        "workout_id":      workout.get("id", ""),
        "workout_name":    workout.get("name", "Unknown"),
        "ftp":             ftp,
        "elapsed":         elapsed_sec,
        "total_duration":  workout.get("total_duration") or sum(
            iv["duration"] for iv in workout.get("intervals", [])
        ),
        "completed":       completed,
        "avg_power":       avg,
        "normalized_power": np,
        "intensity_factor": round(np / ftp, 3) if ftp else 0,
        "tss":             tss,
        "power_samples":   [int(p) for p in power_samples],
    }


# ── Manager ──────────────────────────────────────────────────────────────────

class HistoryManager:
    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)

    def save(self, ride: dict) -> str:
        ride_id = ride["id"]
        (self.dir / f"{ride_id}.json").write_text(json.dumps(ride, indent=2))
        return ride_id

    def list_rides(self) -> list[dict]:
        result = []
        for path in sorted(self.dir.glob("*.json"), reverse=True):
            try:
                data = json.loads(path.read_text())
                data.setdefault("id", path.stem)
                # omit heavy samples from the list view
                data.pop("power_samples", None)
                result.append(data)
            except Exception:
                pass
        return result

    def get_ride(self, ride_id: str) -> Optional[dict]:
        path = self.dir / f"{ride_id}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        data.setdefault("id", ride_id)
        return data

    def delete_ride(self, ride_id: str):
        path = self.dir / f"{ride_id}.json"
        if path.exists():
            path.unlink()
