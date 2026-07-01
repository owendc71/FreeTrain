"""Stores per-day workout assignments in a single JSON file."""
import json
from pathlib import Path


class PlanManager:
    def __init__(self, path: Path):
        self._path = path
        self._data: dict = {}   # {"YYYY-MM-DD": workout_id}
        if path.exists():
            try:
                self._data = json.loads(path.read_text())
            except Exception:
                pass

    def get_plan(self) -> dict:
        return dict(self._data)

    def set_day(self, date_str: str, workout_id: str | None):
        if workout_id:
            self._data[date_str] = workout_id
        else:
            self._data.pop(date_str, None)
        self._path.write_text(json.dumps(self._data, indent=2))
