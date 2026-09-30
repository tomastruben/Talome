"""Regression tests; all state lives in temporary directories."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from stopwatch import StopwatchStore, PersistenceError


class DurabilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'session.json'
        self.store = StopwatchStore(str(self.path))

    def test_running_recovery_is_durably_paused_once(self):
        self.store.start('Recovery')
        with patch('stopwatch.time.time', return_value=time.time() + 5):
            first = StopwatchStore(str(self.path)).snapshot()
        with patch('stopwatch.time.time', return_value=time.time() + 60):
            second = StopwatchStore(str(self.path)).snapshot()
        self.assertEqual(first['status'], 'paused')
        self.assertEqual(second['elapsedMs'], first['elapsedMs'])

    def test_rename_running_and_empty_label_are_persisted(self):
        self.store.start('Initial')
        self.store.start('Changed while running')
        self.assertEqual(StopwatchStore(str(self.path)).snapshot()['label'], 'Changed while running')
        self.store.label('')
        self.assertEqual(StopwatchStore(str(self.path)).snapshot()['label'], '')

    def test_label_does_not_start_or_resume(self):
        self.assertEqual(self.store.label('Plan')['status'], 'ready')
        self.store.start()
        self.store.pause()
        self.assertEqual(self.store.label('Break')['status'], 'paused')

    def test_failed_write_rolls_back_mutations_and_removes_temporary_file(self):
        self.store.start('Keep')
        self.store.lap()
        self.store.pause()
        before = self.store.snapshot()
        original = self.path.read_bytes()
        for operation in [lambda: self.store.start('Lose'), lambda: self.store.label('Lose'), self.store.reset]:
            with patch('stopwatch.os.replace', side_effect=OSError('Disk full')):
                with self.assertRaises(PersistenceError): operation()
            after = self.store.snapshot()
            for key in ['status', 'label', 'elapsedMs', 'laps']:
                self.assertEqual(after[key], before[key])
            self.assertEqual(self.path.read_bytes(), original)
            self.assertEqual(list(self.path.parent.iterdir()), [self.path])
        self.store.start()
        for operation in [self.store.lap, self.store.pause]:
            with patch('stopwatch.os.replace', side_effect=OSError('Disk full')):
                with self.assertRaises(PersistenceError): operation()
            self.assertEqual(self.store.snapshot()['status'], 'running')
            self.assertEqual(self.store.snapshot()['lapCount'], 1)

    def test_bad_numeric_state_does_not_crash_or_recover_before_last_lap(self):
        self.path.write_text(json.dumps({'status': 'running', 'accumulatedMs': 'bad', 'lastLapTotalMs': {}, 'wallAnchor': time.time() + 10, 'laps': [{'index': 1, 'splitMs': 1000, 'totalMs': 1000}]}))
        snapshot = StopwatchStore(str(self.path)).snapshot()
        self.assertGreaterEqual(snapshot['elapsedMs'], 1000)
        self.assertEqual(snapshot['status'], 'paused')
