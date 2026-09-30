"""Timing-core tests. Run with: python -m unittest discover -s tests -t ."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import stopwatch as sw  # noqa: E402


class FormatDurationTest(unittest.TestCase):
    def test_zero(self) -> None:
        self.assertEqual(sw.format_duration(0), "00:00.00")

    def test_hundredths_truncate_rather_than_round(self) -> None:
        # 9.999s must still read 09.99: a stopwatch showing 10.00 has to have
        # actually reached ten seconds.
        self.assertEqual(sw.format_duration(9_999), "00:09.99")
        self.assertEqual(sw.format_duration(10_000), "00:10.00")

    def test_minutes_and_seconds(self) -> None:
        self.assertEqual(sw.format_duration(84_370), "01:24.37")

    def test_widens_past_an_hour(self) -> None:
        self.assertEqual(sw.format_duration(3_600_000), "1:00:00.00")
        self.assertEqual(sw.format_duration(45_296_780), "12:34:56.78")

    def test_negative_clamps_to_zero(self) -> None:
        self.assertEqual(sw.format_duration(-500), "00:00.00")


class StoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._dir.name, "session.json")
        self.store = sw.StopwatchStore(self.path)
        self._clock = 1_000.0
        self._real_monotonic = sw.time.monotonic
        sw.time.monotonic = lambda: self._clock  # type: ignore[assignment]

    def tearDown(self) -> None:
        sw.time.monotonic = self._real_monotonic  # type: ignore[assignment]
        self._dir.cleanup()

    def advance(self, seconds: float) -> None:
        self._clock += seconds

    def read_state(self) -> dict:
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)

    def write_state(self, payload: dict) -> None:
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)


class ReadyStateTest(StoreTestCase):
    def test_starts_ready_and_empty(self) -> None:
        snap = self.store.snapshot()
        self.assertEqual(snap["status"], "ready")
        self.assertEqual(snap["statusLabel"], "Ready")
        self.assertEqual(snap["elapsed"], "00:00.00")
        self.assertEqual(snap["laps"], [])
        self.assertTrue(snap["canStart"])
        self.assertFalse(snap["canLap"])
        self.assertFalse(snap["canPause"])
        self.assertFalse(snap["canReset"])

    def test_lap_before_start_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            self.store.lap()


class RunPauseResumeTest(StoreTestCase):
    def test_elapsed_advances_only_while_running(self) -> None:
        self.store.start()
        self.advance(2.5)
        self.assertEqual(self.store.snapshot()["elapsed"], "00:02.50")

        self.store.pause()
        self.advance(10)
        snap = self.store.snapshot()
        self.assertEqual(snap["elapsed"], "00:02.50")
        self.assertEqual(snap["status"], "paused")

        self.store.start()
        self.advance(1.25)
        self.assertEqual(self.store.snapshot()["elapsed"], "00:03.75")

    def test_start_is_idempotent_while_running(self) -> None:
        self.store.start()
        self.advance(3)
        self.store.start()  # must not restart the anchor and lose 3s
        self.assertEqual(self.store.snapshot()["elapsed"], "00:03.00")

    def test_pause_is_idempotent(self) -> None:
        self.store.start()
        self.advance(1)
        self.store.pause()
        self.store.pause()
        self.assertEqual(self.store.snapshot()["elapsed"], "00:01.00")

    def test_label_is_retained(self) -> None:
        self.store.start("Deep work")
        self.assertEqual(self.store.snapshot()["label"], "Deep work")
        self.store.start()  # a bare resume must not wipe the label
        self.assertEqual(self.store.snapshot()["label"], "Deep work")


class LapTest(StoreTestCase):
    def test_split_and_cumulative_total(self) -> None:
        self.store.start()
        self.advance(5)
        self.store.lap()
        self.advance(3)
        self.store.lap()
        self.advance(7)
        self.store.lap()

        snap = self.store.snapshot()
        self.assertEqual(snap["lapCount"], 3)
        # Newest first, for both surfaces.
        self.assertEqual([lap["index"] for lap in snap["laps"]], [3, 2, 1])

        by_index = {lap["index"]: lap for lap in snap["laps"]}
        self.assertEqual(by_index[1]["split"], "00:05.00")
        self.assertEqual(by_index[1]["total"], "00:05.00")
        self.assertEqual(by_index[2]["split"], "00:03.00")
        self.assertEqual(by_index[2]["total"], "00:08.00")
        self.assertEqual(by_index[3]["split"], "00:07.00")
        self.assertEqual(by_index[3]["total"], "00:15.00")

        # Splits must sum to the final total.
        self.assertEqual(sum(lap["splitMs"] for lap in snap["laps"]), 15_000)
        self.assertEqual(snap["fastestSplitMs"], 3_000)
        self.assertEqual(snap["slowestSplitMs"], 7_000)

    def test_pending_split_tracks_time_since_last_lap(self) -> None:
        self.store.start()
        self.advance(4)
        self.store.lap()
        self.advance(1.5)
        self.assertEqual(self.store.snapshot()["pendingSplitMs"], 1_500)

    def test_lap_across_a_pause_excludes_paused_time(self) -> None:
        self.store.start()
        self.advance(2)
        self.store.pause()
        self.advance(60)  # wall time passes; the stopwatch is held
        self.store.start()
        self.advance(1)
        self.store.lap()
        self.assertEqual(self.store.snapshot()["laps"][0]["split"], "00:03.00")

    def test_lap_limit_is_enforced(self) -> None:
        self.store.start()
        for _ in range(sw.MAX_LAPS):
            self.advance(0.01)
            self.store.lap()
        snap = self.store.snapshot()
        self.assertEqual(snap["lapCount"], sw.MAX_LAPS)
        self.assertFalse(snap["canLap"])
        with self.assertRaises(ValueError):
            self.store.lap()

    def test_fifty_laps_remain_ordered(self) -> None:
        self.store.start()
        for _ in range(50):
            self.advance(1)
            self.store.lap()
        laps = self.store.snapshot()["laps"]
        self.assertEqual(len(laps), 50)
        self.assertEqual([lap["index"] for lap in laps], list(range(50, 0, -1)))
        self.assertEqual(laps[0]["total"], "00:50.00")


class ResetTest(StoreTestCase):
    def test_reset_clears_time_and_laps(self) -> None:
        self.store.start()
        self.advance(9)
        self.store.lap()
        snap = self.store.reset()
        self.assertEqual(snap["status"], "ready")
        self.assertEqual(snap["elapsed"], "00:00.00")
        self.assertEqual(snap["laps"], [])
        self.assertEqual(snap["lapCount"], 0)
        self.assertFalse(snap["canReset"])

    def test_reset_is_persisted(self) -> None:
        self.store.start()
        self.advance(9)
        self.store.lap()
        self.store.reset()
        reloaded = sw.StopwatchStore(self.path)
        self.assertEqual(reloaded.snapshot()["status"], "ready")
        self.assertEqual(reloaded.snapshot()["lapCount"], 0)


class PersistenceTest(StoreTestCase):
    def test_paused_session_survives_a_restart(self) -> None:
        self.store.start("Interval set")
        self.advance(12.34)
        self.store.lap()
        self.store.pause()

        reloaded = sw.StopwatchStore(self.path)
        snap = reloaded.snapshot()
        self.assertEqual(snap["status"], "paused")
        self.assertEqual(snap["elapsed"], "00:12.34")
        self.assertEqual(snap["label"], "Interval set")
        self.assertEqual(snap["lapCount"], 1)
        self.assertFalse(snap["recovered"])

    def test_running_session_is_recovered_as_paused(self) -> None:
        self.store.start()
        self.advance(4)
        # Simulate a restart: the monotonic reference point is gone, so recovery
        # must come from the persisted wall-clock anchor.
        raw = self.read_state()
        self.assertEqual(raw["status"], "running")
        raw["wallAnchor"] = sw.time.time() - 30
        self.write_state(raw)

        reloaded = sw.StopwatchStore(self.path)
        snap = reloaded.snapshot()
        self.assertEqual(snap["status"], "paused")
        self.assertTrue(snap["recovered"])
        self.assertGreaterEqual(snap["elapsedMs"], 29_000)
        self.assertLessEqual(snap["elapsedMs"], 31_500)
        self.assertIn("Recovered", snap["summary"])

    def test_absurd_wall_anchor_is_discarded(self) -> None:
        self.store.start()
        raw = self.read_state()
        raw["wallAnchor"] = sw.time.time() + 5_000  # clock moved backwards
        self.write_state(raw)

        snap = sw.StopwatchStore(self.path).snapshot()
        self.assertEqual(snap["status"], "paused")
        self.assertEqual(snap["elapsedMs"], 0)

    def test_corrupt_state_file_falls_back_to_ready(self) -> None:
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{not json at all")
        self.assertEqual(sw.StopwatchStore(self.path).snapshot()["status"], "ready")

    def test_unusable_laps_are_skipped_not_fatal(self) -> None:
        self.write_state(
            {
                "status": "paused",
                "accumulatedMs": 5_000,
                "lastLapTotalMs": 2_000,
                "laps": [
                    {"index": 1, "splitMs": 2_000, "totalMs": 2_000, "recordedAt": "x"},
                    {"index": "bad"},
                    "not-an-object",
                ],
            }
        )
        snap = sw.StopwatchStore(self.path).snapshot()
        self.assertEqual(snap["lapCount"], 1)
        self.assertEqual(snap["status"], "paused")


class SummaryTest(StoreTestCase):
    def test_ready_summary_mentions_both_surfaces(self) -> None:
        self.assertIn("Stopwatch interface", self.store.snapshot()["summary"])

    def test_running_without_laps(self) -> None:
        self.store.start()
        self.advance(3)
        summary = self.store.snapshot()["summary"]
        self.assertIn("no laps recorded yet", summary)

    def test_summary_names_fastest_and_slowest(self) -> None:
        self.store.start()
        self.advance(5)
        self.store.lap()
        self.advance(2)
        self.store.lap()
        summary = self.store.snapshot()["summary"]
        self.assertIn("Fastest split 00:02.00 on lap 2", summary)
        self.assertIn("slowest 00:05.00 on lap 1", summary)

    def test_single_lap_summary_omits_slowest(self) -> None:
        self.store.start()
        self.advance(5)
        self.store.lap()
        summary = self.store.snapshot()["summary"]
        self.assertIn("1 lap.", summary)
        self.assertNotIn("slowest", summary)


class StatusLabelTest(StoreTestCase):
    def test_labels_match_the_native_badge_contract(self) -> None:
        # Talome's statusVariant() maps "running" to the default badge and
        # "stopped" to destructive; "Paused" must fall through to neutral.
        self.assertEqual(sw.STATUS_LABELS["ready"], "Ready")
        self.assertEqual(sw.STATUS_LABELS["running"], "Running")
        self.assertEqual(sw.STATUS_LABELS["paused"], "Paused")
        self.assertNotIn("stopped", sw.STATUS_LABELS.values())


if __name__ == "__main__":
    unittest.main()
