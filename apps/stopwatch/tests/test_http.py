"""Exercise real HTTP, process restarts, and storage failure with disposable data."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


class HttpWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='stopwatch-http-')
        self.addCleanup(self.tmp.cleanup)
        self.data_dir = Path(self.tmp.name) / 'data'
        self.data_dir.mkdir()
        self.data_path = self.data_dir / 'session.json'
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, str(ROOT / 'server.py')], cwd=ROOT,
            env={'PATH': os.environ.get('PATH', ''), 'BIND_HOST': '127.0.0.1', 'PORT': '0',
                 'STOPWATCH_DATA_PATH': str(self.data_path), 'PYTHONDONTWRITEBYTECODE': '1'},
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(5), 'Server did not report readiness')
        ready = json.loads(self.process.stdout.readline())
        self.assertEqual(ready['host'], '127.0.0.1')
        self.base = f"http://127.0.0.1:{ready['port']}"

    def stop(self):
        if self.process is not None:
            process, self.process = self.process, None
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                self.fail('SIGTERM did not stop the service within three seconds')
            finally:
                process.stdout.close()

    def request(self, path='/api/session', body=None, expected=200):
        payload = None if body is None else json.dumps(body).encode()
        try:
            response = urlopen(Request(self.base + path, data=payload, headers={'Content-Type': 'application/json'}), timeout=3)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.status, expected)
            return json.load(response)

    def command(self, name, body=None, expected=200):
        return self.request('/api/session/' + name, body or {}, expected)

    def test_real_start_lap_pause_resume_reload_restart_reset(self):
        self.assertEqual(self.request()['status'], 'ready')
        self.assertEqual(self.command('label', {'label': 'Disposable workflow'})['session']['status'], 'ready')
        self.command('start')
        time.sleep(0.12)
        lap = self.command('lap')['session']
        self.assertEqual(lap['lapCount'], 1)
        self.assertGreater(lap['laps'][0]['splitMs'], 50)
        paused = self.command('pause')['session']
        time.sleep(0.12)
        self.assertEqual(self.request()['elapsedMs'], paused['elapsedMs'])
        self.stop()
        self.start()
        restored = self.request()
        self.assertEqual(restored['elapsedMs'], paused['elapsedMs'])
        self.assertEqual(restored['laps'], paused['laps'])
        self.assertEqual(restored['label'], 'Disposable workflow')
        self.command('start')
        time.sleep(0.12)
        second = self.command('lap')['session']
        self.assertEqual(second['lapCount'], 2)
        self.assertGreater(second['elapsedMs'], paused['elapsedMs'])
        self.command('reset', expected=409)
        self.assertEqual(self.request()['lapCount'], 2)
        self.assertEqual(self.command('reset', {'confirmed': True})['session']['status'], 'ready')
        self.stop()
        self.start()
        self.assertEqual(self.request()['elapsedMs'], 0)
        self.assertEqual(self.request()['lapCount'], 0)

    def test_disk_failure_returns_503_and_preserves_memory_and_saved_bytes(self):
        self.command('label', {'label': 'Keep me'})
        saved = self.data_path.read_bytes()
        backup = self.data_dir.with_name('saved-data')
        self.data_dir.rename(backup)
        self.data_dir.write_text('This is a file, so persistence must fail')
        failure = self.command('start', expected=503)
        self.assertFalse(failure['ok'])
        self.assertEqual(self.request()['status'], 'ready')
        self.assertEqual(self.request()['label'], 'Keep me')
        self.assertEqual((backup / 'session.json').read_bytes(), saved)
        self.data_dir.unlink()
        backup.rename(self.data_dir)
        self.assertTrue(self.command('start')['ok'])

    def test_restart_running_recovers_then_remains_paused(self):
        self.command('start')
        time.sleep(0.1)
        self.stop()
        self.start()
        first = self.request()
        self.assertEqual(first['status'], 'paused')
        self.assertTrue(first['recovered'])
        self.stop()
        time.sleep(0.1)
        self.start()
        self.assertEqual(self.request()['elapsedMs'], first['elapsedMs'])

    def test_invalid_commands_cannot_mutate_ready_session(self):
        self.command('lap', expected=409)
        self.command('label', {'label': 123}, expected=400)
        self.command('reset', {'confirmed': 'true'}, expected=409)
        self.command('missing', expected=404)
        self.assertEqual(self.request()['status'], 'ready')
