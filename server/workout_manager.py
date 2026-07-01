"""Simple JSON file-based workout storage."""
import json
import uuid
import re
from pathlib import Path
from typing import Optional


class WorkoutManager:
    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)

    def list_workouts(self) -> list[dict]:
        result = []
        for path in sorted(self.dir.glob("*.json")):
            try:
                data = json.loads(path.read_text())
                data["id"] = path.stem
                data["total_duration"] = sum(
                    iv["duration"] for iv in data.get("intervals", [])
                )
                result.append(data)
            except Exception:
                pass
        return result

    def get_workout(self, workout_id: str) -> Optional[dict]:
        path = self.dir / f"{workout_id}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        data["id"] = workout_id
        return data

    def save_workout(self, workout: dict) -> str:
        raw_id = workout.get("id") or str(uuid.uuid4())[:8]
        workout_id = re.sub(r"[^\w\-]", "_", raw_id)
        payload = {k: v for k, v in workout.items() if k not in ("id", "total_duration")}
        (self.dir / f"{workout_id}.json").write_text(json.dumps(payload, indent=2))
        return workout_id

    def delete_workout(self, workout_id: str):
        path = self.dir / f"{workout_id}.json"
        if path.exists():
            path.unlink()
