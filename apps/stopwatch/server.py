"""Stopwatch HTTP service.

Stdlib only. Serves the external web UI and the JSON API that Talome's native
AppSpec surface reads through Core's ``app-api`` proxy, so both surfaces operate
on one shared session.

Routes
    GET  /                     external web UI
    GET  /assets/<name>        stylesheet and script
    GET  /health               liveness probe used by the container healthcheck
    GET  /api/session          current session snapshot
    POST /api/session/start    start or resume (optional JSON body {"label": str})
    POST /api/session/lap      record a split
    POST /api/session/pause    hold the elapsed time
    POST /api/session/reset    clear elapsed time and every lap
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
from socketserver import TCPServer
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from stopwatch import PersistenceError, StopwatchStore

PORT = int(os.environ.get("PORT", "8000"))
BIND_HOST = os.environ.get("BIND_HOST", "0.0.0.0")
DATA_PATH = os.environ.get("STOPWATCH_DATA_PATH", "/data/session.json")
ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

MAX_BODY_BYTES = 8 * 1024

ASSET_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}

STORE = StopwatchStore(DATA_PATH)


def _load_index() -> bytes:
    with open(os.path.join(ASSET_DIR, "index.html"), "rb") as handle:
        return handle.read()


class StopwatchHandler(BaseHTTPRequestHandler):
    server_version = "Stopwatch/1.0"
    protocol_version = "HTTP/1.1"

    # ── helpers ──────────────────────────────────────────────────────────────

    def _send(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
        cache: str = "no-store",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        self._send(
            status,
            json.dumps(payload).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._send_json(status, {"ok": False, "error": message})

    def _read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Invalid Content-Length header.")
        if length < 0:
            raise ValueError("Invalid Content-Length header.")
        if length == 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large.")
        raw = self.rfile.read(length)
        if not raw.strip():
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ValueError("Request body must be valid JSON.")
        if not isinstance(parsed, dict):
            raise ValueError("Request body must be a JSON object.")
        return parsed

    def _serve_asset(self, name: str) -> None:
        # Reject anything that is not a plain file name in the asset directory.
        if name != os.path.basename(name) or name.startswith("."):
            self._error(HTTPStatus.NOT_FOUND, "Not found.")
            return
        extension = os.path.splitext(name)[1]
        content_type = ASSET_TYPES.get(extension)
        if not content_type:
            self._error(HTTPStatus.NOT_FOUND, "Not found.")
            return
        path = os.path.join(ASSET_DIR, name)
        try:
            with open(path, "rb") as handle:
                body = handle.read()
        except OSError:
            self._error(HTTPStatus.NOT_FOUND, "Not found.")
            return
        self._send(HTTPStatus.OK, body, content_type, cache="no-cache")

    # ── routing ──────────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        path = self.path.split("?", 1)[0].rstrip("/") or "/"

        if path in ("/", "/index.html"):
            try:
                body = _load_index()
            except OSError:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "UI is unavailable.")
                return
            self._send(HTTPStatus.OK, body, "text/html; charset=utf-8", cache="no-cache")
            return

        if path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok", "service": "stopwatch"})
            return

        if path == "/api/session":
            self._send_json(HTTPStatus.OK, STORE.snapshot())
            return

        if path.startswith("/assets/"):
            self._serve_asset(path[len("/assets/") :])
            return

        self._error(HTTPStatus.NOT_FOUND, "Not found.")

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib naming
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        commands = {
            "/api/session/start": "start",
            "/api/session/label": "label",
            "/api/session/lap": "lap",
            "/api/session/pause": "pause",
            "/api/session/reset": "reset",
        }
        command = commands.get(path)
        if command is None:
            self._error(HTTPStatus.NOT_FOUND, "Not found.")
            return

        try:
            body = self._read_json_body()
        except ValueError as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
            return

        try:
            if command == "start":
                label = body.get("label")
                if label is not None and not isinstance(label, str):
                    self._error(HTTPStatus.BAD_REQUEST, "label must be a string.")
                    return
                snapshot = STORE.start(label)
            elif command == "label":
                if not isinstance(body.get("label"), str):
                    self._error(HTTPStatus.BAD_REQUEST, "label must be a string.")
                    return
                snapshot = STORE.label(body["label"])
            elif command == "lap":
                snapshot = STORE.lap()
            elif command == "pause":
                snapshot = STORE.pause()
            else:
                if body.get("confirmed") is not True:
                    self._error(HTTPStatus.CONFLICT, "Confirm reset before clearing elapsed time and laps.")
                    return
                snapshot = STORE.reset()
        except PersistenceError as error:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, str(error))
            return
        except ValueError as error:
            self._error(HTTPStatus.CONFLICT, str(error))
            return

        self._send_json(HTTPStatus.OK, {"ok": True, "action": command, "session": snapshot})

    def log_message(self, fmt: str, *args: Any) -> None:
        # Health probes fire every 15s; logging them would bury real errors.
        if self.path.split("?", 1)[0] in ("/health", "/api/session"):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class StopwatchServer(ThreadingHTTPServer):
    def server_bind(self) -> None:
        # HTTPServer performs reverse DNS here; local startup must not depend on DNS.
        TCPServer.server_bind(self)
        self.server_name = self.server_address[0]
        self.server_port = self.server_address[1]


def main() -> None:
    server = StopwatchServer((BIND_HOST, PORT), StopwatchHandler)
    server.daemon_threads = True

    def shutdown(_signum: int, _frame: Any) -> None:
        # A running session needs no write here: its wall-clock anchor is already
        # on disk, and the store reconstructs the elapsed gap on next start.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(json.dumps({"event": "listening", "host": BIND_HOST, "port": server.server_port}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
