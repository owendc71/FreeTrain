"""Workout execution engine – drives ERG mode in real time."""
import asyncio
import logging
import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

log = logging.getLogger(__name__)


class State(Enum):
    IDLE     = "idle"
    RUNNING  = "running"
    PAUSED   = "paused"
    FINISHED = "finished"
    STOPPED  = "stopped"


@dataclass
class Interval:
    duration:  int    # seconds
    power_pct: float  # fraction of FTP  (0.50 = 50%)
    name:      str = ""

    @property
    def zone(self) -> str:
        p = self.power_pct
        if p < 0.55: return "recovery"
        if p < 0.76: return "endurance"
        if p < 0.90: return "tempo"
        if p < 1.05: return "threshold"
        if p < 1.20: return "vo2max"
        if p < 1.50: return "anaerobic"
        return "neuromuscular"


class WorkoutEngine:
    def __init__(self, workout: dict, ftp: int, trainer, broadcast: Callable,
                 simulate: bool = False):
        self.workout    = workout
        self.ftp        = ftp
        self.trainer    = trainer
        self.broadcast  = broadcast
        self.simulate   = simulate

        self.intervals: list[Interval] = [
            Interval(
                duration=int(iv["duration"]),
                power_pct=float(iv["power_pct"]),
                name=iv.get("name", ""),
            )
            for iv in workout["intervals"]
        ]

        self.state            = State.IDLE
        self.interval_idx     = 0
        self.interval_elapsed = 0
        self.total_elapsed    = 0
        self.power_offset     = 0      # user ± adjustment in watts

        self._stop  = asyncio.Event()
        self._pause = asyncio.Event()
        self._pause.set()   # not paused initially

        # power samples (one per second of actual riding) for history
        self._power_samples: list[float] = []

        # simulator state: tracks current simulated power (low-pass toward target)
        self._sim_power: float = float(ftp) * 0.5
        self._sim_cadence: float = 88.0

    # ---------------------------------------------------------------- props

    @property
    def total_duration(self) -> int:
        return sum(iv.duration for iv in self.intervals)

    @property
    def current_interval(self) -> Optional[Interval]:
        if self.interval_idx < len(self.intervals):
            return self.intervals[self.interval_idx]
        return None

    @property
    def target_power(self) -> int:
        iv = self.current_interval
        if iv is None:
            return 0
        return max(0, int(iv.power_pct * self.ftp) + self.power_offset)

    # ----------------------------------------------------------------- run

    async def run(self):
        self.state = State.RUNNING

        if self.trainer.trainer_client:
            await self.trainer.acquire_control()
            await self.trainer.start_training()

        await self._push_power()
        await self._emit_status()

        try:
            while not self._stop.is_set():
                await self._pause.wait()
                if self._stop.is_set():
                    break

                await asyncio.sleep(1)

                if self.state != State.RUNNING:
                    continue

                self.total_elapsed    += 1
                self.interval_elapsed += 1

                if self.simulate:
                    await self._emit_simulated_data()

                iv = self.current_interval
                if iv and self.interval_elapsed >= iv.duration:
                    self.interval_idx    += 1
                    self.interval_elapsed = 0

                    if self.interval_idx >= len(self.intervals):
                        await self._finish()
                        return

                    await self._push_power()

                await self._emit_status()

        except asyncio.CancelledError:
            pass
        finally:
            if self.state not in (State.FINISHED, State.STOPPED):
                await self.stop()

    # --------------------------------------------------------------- control

    async def pause(self):
        self.state = State.PAUSED
        self._pause.clear()
        await self.broadcast({"type": "workout_status", "state": "paused",
                              "total_elapsed": self.total_elapsed})

    async def resume(self):
        self.state = State.RUNNING
        self._pause.set()
        await self._push_power()
        await self._emit_status()

    def record_power(self, watts: float):
        """Called by main.py each time live power data arrives."""
        if self.state == State.RUNNING:
            self._power_samples.append(watts)

    async def stop(self):
        self.state = State.STOPPED
        self._stop.set()
        self._pause.set()
        if self.trainer.trainer_client:
            await self.trainer.stop_training()
        await self.broadcast({
            "type":          "workout_status",
            "state":         "stopped",
            "total_elapsed": self.total_elapsed,
        })
        # Broadcast ride summary so main.py can persist it
        if self.total_elapsed >= 60:
            await self.broadcast(self._ride_summary(completed=False))

    async def skip_interval(self):
        self.interval_idx    += 1
        self.interval_elapsed = 0
        if self.interval_idx >= len(self.intervals):
            await self._finish()
            return
        await self._push_power()
        await self._emit_status()

    # ----------------------------------------------------------- internals

    async def _emit_simulated_data(self):
        """
        Generate realistic fake power/cadence data.
        Uses a low-pass filter so power drifts toward the target rather than
        snapping instantly, plus Gaussian noise for natural variation.
        """
        target = float(self.target_power)

        # ~3 second response lag (alpha = 0.33 per tick)
        alpha = 0.33
        self._sim_power += alpha * (target - self._sim_power)
        # ±6W noise
        noisy_power = max(0.0, self._sim_power + random.gauss(0, 6))

        # cadence drifts gently between 85-95 rpm
        self._sim_cadence += random.gauss(0, 0.5)
        self._sim_cadence = max(82.0, min(98.0, self._sim_cadence))

        await self.broadcast({
            "type":    "live_data",
            "power":   round(noisy_power),
            "cadence": round(self._sim_cadence),
        })

    async def _push_power(self):
        watts = self.target_power
        if self.trainer.trainer_client:
            await self.trainer.set_target_power(watts)
        iv = self.current_interval
        if iv:
            log.info(
                "Interval %d/%d '%s' @ %dW (%.0f%% FTP)",
                self.interval_idx + 1, len(self.intervals),
                iv.name or iv.zone, watts, iv.power_pct * 100,
            )

    async def _emit_status(self):
        iv = self.current_interval
        if iv is None:
            return
        await self.broadcast({
            "type":               "workout_status",
            "state":              self.state.value,
            "total_elapsed":      self.total_elapsed,
            "total_duration":     self.total_duration,
            "interval_idx":       self.interval_idx,
            "interval_elapsed":   self.interval_elapsed,
            "interval_duration":  iv.duration,
            "interval_name":      iv.name or iv.zone,
            "interval_zone":      iv.zone,
            "interval_power_pct": iv.power_pct,
            "target_power":       self.target_power,
            "ftp":                self.ftp,
            "intervals_total":    len(self.intervals),
            "power_offset":       self.power_offset,
        })

    async def _finish(self):
        self.state = State.FINISHED
        self._stop.set()
        if self.trainer.trainer_client:
            await self.trainer.stop_training()
        await self.broadcast({
            "type":          "workout_finished",
            "total_elapsed": self.total_elapsed,
            "workout_name":  self.workout.get("name", ""),
        })
        await self.broadcast(self._ride_summary(completed=True))

    def _ride_summary(self, completed: bool) -> dict:
        from history_manager import build_ride_summary
        summary = build_ride_summary(
            workout=self.workout,
            ftp=self.ftp,
            elapsed_sec=self.total_elapsed,
            power_samples=self._power_samples,
            completed=completed,
        )
        return {"type": "save_ride", "ride": summary}
