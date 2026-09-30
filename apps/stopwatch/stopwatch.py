"""Stopwatch timing core and durable session store.

No third-party dependencies. Elapsed time is measured with ``time.monotonic()``,
which the Python documentation defines as "a clock that cannot go backwards. The
clock is not affected by system clock updates." Because that clock's "reference
point ... is undefined", a wall-clock anchor is persisted alongside it so a
session that was running when the process stopped can still be recovered.

The store is the single source of truth. Both the external web UI and Talome's
native AppSpec surface read the same snapshot, so they can never disagree.
"""

from __future__ import annotations

import copy
from contextlib import contextmanager
import json
import os
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal

Status = Literal["ready", "running", "paused"]

#: Status strings surfaced to Talome. ``native-app-blocks.tsx`` maps the literal
#: lowercase string "running" to the default badge and "stopped" to destructive;
#: "Paused" deliberately falls through to the neutral secondary badge.
STATUS_LABELS: dict[str, str] = {
    "ready": "Ready",
    "running": "Running",
    "paused": "Paused",
}

MAX_LAPS = 500


def format_duration(total_ms: int) -> str:
    """Render milliseconds as ``MM:SS.hh``, widening to ``H:MM:SS.hh`` past an hour.

    Truncates rather than rounds: a stopwatch showing 10.00 must have reached ten
    seconds, not merely come within 5 ms of it.
    """
    total_ms = max(0, int(total_ms))
    hundredths = (total_ms // 10) % 100
    seconds = (total_ms // 1_000) % 60
    minutes = (total_ms // 60_000) % 60
    hours = total_ms // 3_600_000
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}.{hundredths:02d}"
    return f"{minutes:02d}:{seconds:02d}.{hundredths:02d}"


@dataclass
class Lap:
    index: int
    split_ms: int
    total_ms: int
    recorded_at: str

    def to_public(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "name": f"Lap {self.index}",
            "splitMs": self.split_ms,
            "totalMs": self.total_ms,
            "split": format_duration(self.split_ms),
            "total": format_duration(self.total_ms),
            "recordedAt": self.recorded_at,
        }


@dataclass
class Session:
    """Persisted timing state.

    ``accumulated_ms`` holds completed run time. While running, the live delta is
    measured from ``monotonic_anchor``; ``wall_anchor`` exists only so a restart
    can recover an interrupted session, since the monotonic reference point does
    not survive the process.
    """

    status: Status = "ready"
    label: str = ""
    accumulated_ms: int = 0
    monotonic_anchor: float | None = None
    wall_anchor: float | None = None
    laps: list[Lap] = field(default_factory=list)
    last_lap_total_ms: int = 0
    started_at: str | None = None
    updated_at: str = ""
    recovered: bool = False


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class PersistenceError(OSError):
    """The requested change could not be saved; its in-memory change was rolled back."""


class StopwatchStore:
    """Thread-safe session store with atomic JSON persistence."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.RLock()
        self._session = Session(updated_at=_utc_now_iso())
        self._load()

    # ── persistence ──────────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            with open(self._path, encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, ValueError):
            return

        if not isinstance(raw, dict):
            return

        status = raw.get("status")
        if status not in ("ready", "running", "paused"):
            status = "ready"

        laps: list[Lap] = []
        for item in (raw.get("laps") if isinstance(raw.get("laps"), list) else []):
            if not isinstance(item, dict):
                continue
            try:
                laps.append(
                    Lap(
                        index=int(item["index"]),
                        split_ms=max(0, int(item["splitMs"])),
                        total_ms=max(0, int(item["totalMs"])),
                        recorded_at=str(item.get("recordedAt") or _utc_now_iso()),
                    )
                )
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
        laps.sort(key=lambda lap: lap.index)
        laps = laps[:MAX_LAPS]

        session = Session(
            status=status,
            label=str(raw.get("label") or ""),
            accumulated_ms=_nonnegative_int(raw.get("accumulatedMs")),
            laps=laps,
            last_lap_total_ms=max([_nonnegative_int(raw.get("lastLapTotalMs"))] + [lap.total_ms for lap in laps]),
            started_at=raw.get("startedAt") or None,
            updated_at=str(raw.get("updatedAt") or _utc_now_iso()),
        )

        if session.status == "running":
            # The monotonic reference point did not survive the restart. Recover
            # the gap from the persisted wall-clock anchor, which is the only
            # clock that spans processes, and mark the session so the surface can
            # say so honestly. A backwards or absurd jump is discarded rather
            # than trusted.
            wall_anchor = raw.get("wallAnchor")
            recovered_ms = 0
            if isinstance(wall_anchor, (int, float)):
                delta = time.time() - float(wall_anchor)
                if 0 <= delta <= 86_400:
                    recovered_ms = int(delta * 1_000)
            session.accumulated_ms += recovered_ms
            session.status = "paused"
            session.recovered = True
            session.monotonic_anchor = None
            session.wall_anchor = None

        session.accumulated_ms = max(session.accumulated_ms, session.last_lap_total_ms)
        self._session = session
        if session.recovered:
            # Persist the paused recovery once; subsequent restarts cannot add time.
            self._persist_locked()

    @contextmanager
    def _transaction(self):
        with self._lock:
            previous = copy.deepcopy(self._session)
            try:
                yield
            except PersistenceError:
                self._session = previous
                raise

    def _persist_locked(self) -> None:
        session = self._session
        payload = {
            "status": session.status,
            "label": session.label,
            "accumulatedMs": session.accumulated_ms,
            "wallAnchor": session.wall_anchor,
            "lastLapTotalMs": session.last_lap_total_ms,
            "startedAt": session.started_at,
            "updatedAt": session.updated_at,
            "laps": [
                {
                    "index": lap.index,
                    "splitMs": lap.split_ms,
                    "totalMs": lap.total_ms,
                    "recordedAt": lap.recorded_at,
                }
                for lap in session.laps
            ],
        }
        directory = os.path.dirname(self._path) or "."
        temporary_path = None
        try:
            os.makedirs(directory, exist_ok=True)
            handle = tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=directory,
                prefix=".stopwatch-",
                suffix=".tmp",
                delete=False,
            )
            temporary_path = handle.name
            try:
                json.dump(payload, handle)
                handle.flush()
                os.fsync(handle.fileno())
            finally:
                handle.close()
            os.replace(handle.name, self._path)
        except OSError as error:
            raise PersistenceError("Could not save the session. No change was applied; check storage and retry.") from error
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)

    # ── derived values ───────────────────────────────────────────────────────

    def _elapsed_ms_locked(self) -> int:
        session = self._session
        elapsed = session.accumulated_ms
        if session.status == "running" and session.monotonic_anchor is not None:
            elapsed += int((time.monotonic() - session.monotonic_anchor) * 1_000)
        return max(0, elapsed)

    def _summary_locked(self, elapsed_ms: int) -> str:
        session = self._session
        if session.recovered and session.status == "paused":
            return (
                f"Recovered a session that was still running when Stopwatch "
                f"restarted, and paused it at {format_duration(elapsed_ms)}. "
                "Resume or reset to continue."
            )
        if session.status == "ready":
            return (
                "No session yet. Start the stopwatch here or in the Stopwatch "
                "interface — both control the same session."
            )
        if not session.laps:
            state = "Running" if session.status == "running" else "Paused"
            return (
                f"{state} at {format_duration(elapsed_ms)} with no laps recorded "
                "yet. Record a lap to capture a split."
            )

        fastest = min(session.laps, key=lambda lap: lap.split_ms)
        slowest = max(session.laps, key=lambda lap: lap.split_ms)
        count = len(session.laps)
        noun = "lap" if count == 1 else "laps"
        state = "Running" if session.status == "running" else "Paused"
        line = (
            f"{state} at {format_duration(elapsed_ms)} across {count} {noun}. "
            f"Fastest split {format_duration(fastest.split_ms)} on lap "
            f"{fastest.index}"
        )
        if count > 1:
            line += (
                f"; slowest {format_duration(slowest.split_ms)} on lap "
                f"{slowest.index}"
            )
        return line + "."

    def snapshot(self) -> dict[str, Any]:
        """Public session payload, shared by the web UI and the native surface."""
        with self._lock:
            session = self._session
            elapsed_ms = self._elapsed_ms_locked()
            laps = [lap.to_public() for lap in reversed(session.laps)]
            splits = [lap.split_ms for lap in session.laps]
            return {
                "status": session.status,
                "statusLabel": STATUS_LABELS[session.status],
                "label": session.label,
                "elapsedMs": elapsed_ms,
                "elapsed": format_duration(elapsed_ms),
                "running": session.status == "running",
                "lapCount": len(session.laps),
                "laps": laps,
                "fastestSplitMs": min(splits) if splits else None,
                "slowestSplitMs": max(splits) if splits else None,
                "pendingSplitMs": max(0, elapsed_ms - session.last_lap_total_ms),
                "canStart": session.status != "running",
                "canLap": session.status == "running" and len(session.laps) < MAX_LAPS,
                "canPause": session.status == "running",
                "canReset": session.status != "ready" or bool(session.laps),
                "lapLimit": MAX_LAPS,
                "recovered": session.recovered,
                "startedAt": session.started_at,
                "updatedAt": session.updated_at,
                "summary": self._summary_locked(elapsed_ms),
                "serverTime": _utc_now_iso(),
            }

    # ── commands ─────────────────────────────────────────────────────────────

    def start(self, label: str | None = None) -> dict[str, Any]:
        """Start a fresh session or resume a paused one. Idempotent while running."""
        with self._transaction():
            session = self._session
            label_changed = label is not None and session.label != label[:120]
            if label is not None:
                session.label = label[:120]
            if session.status != "running":
                if session.status == "ready":
                    session.started_at = _utc_now_iso()
                session.status = "running"
                session.monotonic_anchor = time.monotonic()
                session.wall_anchor = time.time()
                session.recovered = False
                session.updated_at = _utc_now_iso()
                self._persist_locked()
            elif label_changed:
                session.updated_at = _utc_now_iso()
                self._persist_locked()
            return self.snapshot()

    def label(self, label: str) -> dict[str, Any]:
        """Rename without starting or resuming the timer; an empty label clears it."""
        with self._transaction():
            self._session.label = label[:120]
            self._session.updated_at = _utc_now_iso()
            self._persist_locked()
            return self.snapshot()

    def pause(self) -> dict[str, Any]:
        """Hold the elapsed time. Idempotent when not running."""
        with self._transaction():
            session = self._session
            if session.status == "running":
                session.accumulated_ms = self._elapsed_ms_locked()
                session.status = "paused"
                session.monotonic_anchor = None
                session.wall_anchor = None
                session.updated_at = _utc_now_iso()
                self._persist_locked()
            return self.snapshot()

    def lap(self) -> dict[str, Any]:
        """Record a split while running. Raises ValueError when not permitted."""
        with self._transaction():
            session = self._session
            if session.status != "running":
                raise ValueError("Start the stopwatch before recording a lap.")
            if len(session.laps) >= MAX_LAPS:
                raise ValueError(f"This session already holds {MAX_LAPS} laps.")
            total_ms = self._elapsed_ms_locked()
            session.laps.append(
                Lap(
                    index=len(session.laps) + 1,
                    split_ms=max(0, total_ms - session.last_lap_total_ms),
                    total_ms=total_ms,
                    recorded_at=_utc_now_iso(),
                )
            )
            session.last_lap_total_ms = total_ms
            session.updated_at = _utc_now_iso()
            self._persist_locked()
            return self.snapshot()

    def reset(self) -> dict[str, Any]:
        """Clear elapsed time and every lap. Callers must confirm first."""
        with self._transaction():
            self._session = Session(updated_at=_utc_now_iso())
            self._persist_locked()
            return self.snapshot()
