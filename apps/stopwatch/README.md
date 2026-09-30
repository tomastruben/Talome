# Stopwatch

Maintained source for the installed Stopwatch service. Python's standard library
serves a shared timing API and a small browser interface; `talome-app.json` connects
the same API to Talome's native shadcn renderer. The native surface refreshes every
two seconds, while the standalone page interpolates the latest server time.

## Run and test without touching installed sessions

From this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
BIND_HOST=127.0.0.1 PORT=0 STOPWATCH_DATA_PATH=/tmp/my-disposable-stopwatch/session.json python3 server.py
```

Startup emits JSON `{ "event": "listening", "host": "127.0.0.1", "port": 12345 }`
with the actual bound port. Use a fresh disposable directory for each test run.
There are 37 tests: deterministic timing/lap checks, storage-failure rollback,
real HTTP workflows, process restart persistence, and bounded SIGTERM shutdown.
`talome-runtime-probe.json` opts into the reviewed `stopwatch-v1` runtime probe;
that probe uses disposable storage and does not send actions to the live service.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/session` | Current status, elapsed time, laps, capability flags, label and summary. |
| POST | `/api/session/start` | Start or resume; optional `{ "label": "Focus" }`. Idempotent while running. |
| POST | `/api/session/label` | `{ "label": "Focus" }` renames without changing timing state; empty clears it. |
| POST | `/api/session/lap` | Record split and cumulative time; 409 when paused or at the 500-lap limit. |
| POST | `/api/session/pause` | Pause without clearing elapsed time or laps. |
| POST | `/api/session/reset` | Requires `{ "confirmed": true }`; clears time, laps and label. |
| GET | `/health` | Liveness only. |

Successful actions return `{ "ok": true, "action": "pause", "session": {...} }`.
A failed session write returns HTTP 503 and rolls back the in-memory mutation;
previously saved bytes stay intact. Recovery cannot claim success if it cannot
persist the recovered paused state. Health is a liveness check, not proof that
storage is writable.

Elapsed time uses a monotonic clock within one process. On restart, the existing
wall-clock anchor estimates interruption time (up to 24 hours), then the session
is durably paused once. Repeated restarts do not keep adding time. Implausible
wall-clock gaps are discarded and elapsed time never recovers before the last
recorded lap. This preserves compatibility with the existing JSON state format.

The browser freezes its display and disables actions when disconnected. Retry
fetches the current session. Late GET responses cannot overwrite a newer action;
a pending action disables controls. Reset requires a dialog confirmation and a
server-side confirmation flag. Session names persist without starting the timer.

## Upgrade and compatibility

The observed live container already uses Python, port `5012:8000`, and the named
Docker volume `stopwatch-data` mounted at `/data`; its session is `/data/session.json`.
The installed app directory still contained an older Node source/Compose and a
static native spec. Those stale files must not be used to infer the running
container's data layout.

Before deployment, preserve the existing image, installed metadata/source, and
named-volume data. Build this directory, keep the existing named volume and port,
and update native metadata only after the new API is healthy. The native action
`reset-session` includes the required confirmation body; old external pages must
reload to use the updated reset contract. Existing browser-local storage is not
migrated or deleted: the currently running Python service already owns its shared
session independently of that older browser-only UI.

`docker-compose.yml` explicitly retains `stopwatch-data`, uid 10001, port 5012,
the memory/CPU limits and the existing time zone. Do not run `down --volumes`.
The native API resolver must point `stopwatch_url` at `http://127.0.0.1:5012` (or
use the installed app's registered URL). AppSpec revisions must be normalized to
the current installed revision before guarded publication.

## Scope

This stores one active session with up to 500 laps; it is not a multi-session
archive. Restart recovery estimates elapsed interruption time from the wall clock.
Storage tests cover atomic file replacement and reported write failure, not sudden
host power loss. Native rendering uses the shared renderer and has a two-second
poll interval, so it does not animate every hundredth like the standalone page.
