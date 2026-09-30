import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// No workspace commands, dependencies, environment files or model-authored reports are executed.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
assert.deepEqual(Object.keys(input.sources), ["server.py", "stopwatch.py"]);
assert.equal(createHash("sha256").update(JSON.stringify(input.sources)).digest("hex"), input.binding.adapterSha256);
const root = await mkdtemp(join(tmpdir(), "talome-stopwatch-probe-"));
const serviceDir = join(root, "service");
const statePath = join(root, "session.json");
const checks = [];
let child;
let origin;
let stderr = "";
const report = { version: 1, scope: "app-runtime", adapter: "stopwatch-v1", binding: input.binding,
  generatedAt: new Date().toISOString(), status: "failed", checks,
  unverified: ["Production data and deployment integration", "Browser to service wiring and external UI", "Arbitrary backend code and hostile same-user OS processes"] };
const bootstrap = `
import sys, os, runpy, socket
root = os.path.realpath(sys.argv[1])
# HTTPServer resolves its loopback hostname during construction; no DNS is needed.
socket.getfqdn = lambda name='': name or 'localhost'
def guard(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo', 'socket.gethostbyaddr', 'socket.gethostbyname', 'subprocess.Popen', 'os.system'):
        raise PermissionError('Runtime probe disallows outbound networking and child commands')
    if event == 'socket.bind' and args[1] != ('127.0.0.1', 0):
        raise PermissionError('Runtime probe requires ephemeral loopback binding')
    if event == 'open':
        path, mode, flags = args
        if isinstance(path, (str, bytes)) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            if os.path.realpath(path) != root and not os.path.realpath(path).startswith(root + os.sep):
                raise PermissionError('Runtime probe writes must stay in disposable state')
sys.addaudithook(guard)
sys.path.insert(0, os.path.join(root, 'service'))
runpy.run_path(os.path.join(root, 'service', 'server.py'), run_name='__main__')
`;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => current.kill("SIGKILL"), 1500);
    current.once("exit", () => { clearTimeout(timeout); resolve(); });
    current.kill("SIGTERM");
  });
}
async function start() {
  stderr = "";
  child = spawn("python3", ["-I", "-B", "-c", bootstrap, root], {
    cwd: serviceDir, shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root,
      BIND_HOST: "127.0.0.1", PORT: "0", STOPWATCH_DATA_PATH: statePath },
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Stopwatch service startup timed out")), 5000);
    let output = "";
    const finish = (error, value) => { clearTimeout(timeout); error ? reject(error) : resolve(value); };
    child.once("error", (error) => finish(error));
    child.once("exit", () => finish(new Error(`Stopwatch service exited before readiness: ${stderr}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 4096) return finish(new Error("Unexpected service startup output"));
      if (!output.includes("\n")) return;
      try {
        const ready = JSON.parse(output.split("\n")[0]);
        assert.equal(ready.event, "listening"); assert.equal(ready.host, "127.0.0.1");
        assert(Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535);
        finish(null, `http://127.0.0.1:${ready.port}`);
      } catch (error) { finish(error); }
    });
  });
}
async function request(action, body, status = 200) {
  const response = await fetch(`${origin}/api/session${action ? `/${action}` : ""}`, {
    method: action ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(2000),
    headers: { "content-type": "application/json" }, ...(action ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const json = await response.json();
  assert.equal(response.status, status, `${action || "session"}: expected HTTP ${status}; ${json.error ?? "unexpected response"}; ${stderr}`);
  return action && status === 200 ? json.session : json;
}
function passed(id, details) { checks.push({ id, status: "passed", details }); }
try {
  await mkdir(serviceDir, { mode: 0o700 });
  for (const [file, bytes] of Object.entries(input.sources)) await writeFile(join(serviceDir, file), Buffer.from(bytes, "base64"), { mode: 0o600 });
  await start();
  let session = await request();
  assert.equal(session.status, "ready"); assert.equal(session.elapsedMs, 0); assert.equal(session.lapCount, 0);
  passed("fresh-state", "New private state begins ready with zero elapsed time and laps.");
  await request("lap", {}, 409); await request("label", { label: 42 }, 400);
  await request("reset", {}, 409);
  passed("invalid-actions", "Lap while idle, invalid label and unconfirmed reset are rejected.");
  session = await request("start", { label: "Probe session" }); assert.equal(session.status, "running");
  session = await request("label", { label: "Renamed probe" }); assert.equal(session.label, "Renamed probe"); assert.equal(session.status, "running");
  passed("start-and-label", "Start and rename return real running session state.");
  await delay(150);
  session = await request("lap"); assert.equal(session.lapCount, 1); assert(session.elapsedMs > 0); assert(session.laps[0].splitMs > 0);
  passed("elapsed-and-lap", "Elapsed time advances and a positive lap is persisted.");
  session = await request("pause"); const pausedMs = session.elapsedMs; assert.equal(session.status, "paused");
  await delay(100); assert.equal((await request()).elapsedMs, pausedMs);
  passed("pause", "Paused elapsed time stays fixed.");
  const persisted = JSON.parse(await readFile(statePath, "utf8")); assert.equal(persisted.label, "Renamed probe"); assert.equal(persisted.laps.length, 1);
  await stop(); await start(); session = await request();
  assert.equal(session.status, "paused"); assert.equal(session.label, "Renamed probe"); assert.equal(session.elapsedMs, pausedMs); assert.equal(session.lapCount, 1);
  passed("restart-persistence", "A new service process recovers the same label, lap and paused duration from disk.");
  await request("start"); await stop(); await start(); session = await request();
  assert.equal(session.status, "paused"); assert.equal(session.recovered, true); assert(session.elapsedMs >= pausedMs); assert.equal(session.lapCount, 1);
  passed("running-recovery", "Restarting a running session recovers elapsed time and safely pauses it.");
  await request("reset", {}, 409); assert.equal((await request()).lapCount, 1);
  session = await request("reset", { confirmed: true }); assert.equal(session.status, "ready"); assert.equal(session.elapsedMs, 0); assert.equal(session.lapCount, 0);
  await stop(); await start(); session = await request(); assert.equal(session.elapsedMs, 0); assert.equal(session.lapCount, 0);
  passed("confirmed-reset", "Unconfirmed reset preserves state; confirmed reset clears and persists disposable state only.");
  passed("isolation", "Reviewed source bytes only; isolated Python, private HOME/CWD/state, ephemeral loopback, outbound and child commands denied.");
  report.status = "passed";
} catch (error) {
  checks.push({ id: "workflow", status: "failed", details: error instanceof Error ? error.message : String(error) });
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(report));
