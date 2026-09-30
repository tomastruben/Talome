/* Stopwatch — external surface controller.
 *
 * The service owns the session; this page renders it. Every snapshot arriving
 * from the service is anchored to performance.now(), which MDN documents as "a
 * monotonic clock: its current time never decreases and isn't subject to
 * adjustments". The digits are interpolated from that anchor between polls, so
 * they stay smooth without trusting the wall clock, and they never drift away
 * from the service because each poll re-anchors them.
 */
(function () {
  "use strict";

  var POLL_RUNNING_MS = 2000;
  var POLL_IDLE_MS = 5000;
  var REDUCED_MOTION_TICK_MS = 250;

  var el = {
    statePill: document.getElementById("state-pill"),
    stateWord: document.getElementById("state-word"),
    readout: document.getElementById("readout"),
    readoutMain: document.getElementById("readout-main"),
    readoutFraction: document.getElementById("readout-fraction"),
    splitLine: document.getElementById("split-line"),
    splitValue: document.getElementById("split-value"),
    primary: document.getElementById("primary-button"),
    lap: document.getElementById("lap-button"),
    reset: document.getElementById("reset-button"),
    errorRegion: document.getElementById("error-region"),
    errorMessage: document.getElementById("error-message"),
    retry: document.getElementById("retry-button"),
    lapRegion: document.getElementById("lap-region"),
    lapList: document.getElementById("lap-list"),
    lapCount: document.getElementById("lap-count"),
    lapEmpty: document.getElementById("lap-empty"),
    recoveredNote: document.getElementById("recovered-note"),
    dialog: document.getElementById("reset-dialog"),
    dialogCount: document.getElementById("reset-dialog-count"),
    announcer: document.getElementById("announcer"),
    labelForm: document.getElementById("session-label-form"),
    labelInput: document.getElementById("session-label"),
    labelSave: document.getElementById("save-label"),
  };

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var state = {
    session: null,
    anchorPerf: 0,
    anchorElapsedMs: 0,
    anchorPendingMs: 0,
    busy: false,
    stale: false,
    lastStatus: null,
    lastLapCount: 0,
    frame: null,
    interval: null,
    pollTimer: null,
    lastRenderedElapsed: null,
    lastRenderedSplit: null,
    labelDirty: false,
  };

  /* ── formatting ──────────────────────────────────────────────────────── */

  function pad(value, width) {
    var text = String(value);
    while (text.length < width) text = "0" + text;
    return text;
  }

  /** Mirrors format_duration() in stopwatch.py, truncating rather than rounding. */
  function formatDuration(totalMs) {
    var ms = Math.max(0, Math.floor(totalMs));
    var hundredths = Math.floor(ms / 10) % 100;
    var seconds = Math.floor(ms / 1000) % 60;
    var minutes = Math.floor(ms / 60000) % 60;
    var hours = Math.floor(ms / 3600000);
    var head = hours
      ? hours + ":" + pad(minutes, 2) + ":" + pad(seconds, 2)
      : pad(minutes, 2) + ":" + pad(seconds, 2);
    return { main: head, fraction: "." + pad(hundredths, 2) };
  }

  function formatFull(totalMs) {
    var parts = formatDuration(totalMs);
    return parts.main + parts.fraction;
  }

  /* ── derived time ────────────────────────────────────────────────────── */

  function liveOffsetMs() {
    if (state.stale || !state.session || !state.session.running) return 0;
    return Math.max(0, performance.now() - state.anchorPerf);
  }

  function currentElapsedMs() {
    return state.anchorElapsedMs + liveOffsetMs();
  }

  function currentPendingMs() {
    return state.anchorPendingMs + liveOffsetMs();
  }

  /* ── rendering ───────────────────────────────────────────────────────── */

  function paintReadout() {
    var session = state.session;
    if (!session) return;

    var elapsed = currentElapsedMs();
    var parts = formatDuration(elapsed);
    var full = parts.main + parts.fraction;
    if (full !== state.lastRenderedElapsed) {
      el.readoutMain.textContent = parts.main;
      el.readoutFraction.textContent = parts.fraction;
      state.lastRenderedElapsed = full;
    }

    if (session.lapCount > 0 && session.status !== "ready") {
      var split = formatFull(currentPendingMs());
      if (split !== state.lastRenderedSplit) {
        el.splitValue.textContent = split;
        state.lastRenderedSplit = split;
      }
      el.splitLine.hidden = false;
    } else {
      el.splitLine.hidden = true;
      state.lastRenderedSplit = null;
    }
  }

  function stopTicking() {
    if (state.frame !== null) {
      cancelAnimationFrame(state.frame);
      state.frame = null;
    }
    if (state.interval !== null) {
      clearInterval(state.interval);
      state.interval = null;
    }
  }

  function startTicking() {
    stopTicking();
    if (state.stale || !state.session || !state.session.running) return;
    if (reducedMotion.matches) {
      // Still truthful, just without the fast visual change.
      state.interval = setInterval(paintReadout, REDUCED_MOTION_TICK_MS);
      return;
    }
    var step = function () {
      paintReadout();
      state.frame = requestAnimationFrame(step);
    };
    state.frame = requestAnimationFrame(step);
  }

  function primaryLabel(session) {
    if (session.status === "running") return "Pause";
    if (session.status === "paused") return "Resume";
    return "Start";
  }

  function renderLaps(session) {
    if (session.status === "ready" && session.lapCount === 0) {
      el.lapRegion.hidden = true;
      return;
    }
    el.lapRegion.hidden = false;

    var count = session.lapCount;
    el.lapCount.textContent = count
      ? count + (count === 1 ? " lap" : " laps")
      : "";
    el.lapEmpty.hidden = count > 0;

    if (!count) {
      el.lapList.textContent = "";
      return;
    }

    var fragment = document.createDocumentFragment();
    session.laps.forEach(function (lap, position) {
      var row = document.createElement("li");
      row.className = "lap-row" + (position === 0 ? " is-newest" : "");

      var name = document.createElement("span");
      name.className = "lap-row__name";
      name.textContent = lap.name;
      row.appendChild(name);

      var splitCell = document.createElement("span");
      splitCell.className = "lap-row__figure lap-row__split";
      splitCell.textContent = lap.split;
      if (count > 1 && lap.splitMs === session.fastestSplitMs) {
        splitCell.appendChild(tag("Fastest"));
      } else if (count > 1 && lap.splitMs === session.slowestSplitMs) {
        splitCell.appendChild(tag("Slowest"));
      }
      row.appendChild(splitCell);

      var totalCell = document.createElement("span");
      totalCell.className = "lap-row__figure lap-row__total";
      totalCell.textContent = lap.total;
      row.appendChild(totalCell);

      fragment.appendChild(row);
    });

    el.lapList.textContent = "";
    el.lapList.appendChild(fragment);
  }

  function tag(text) {
    var span = document.createElement("span");
    span.className = "lap-row__tag";
    span.textContent = text;
    return span;
  }

  function render() {
    var session = state.session;
    if (!session) return;

    el.stateWord.textContent = state.stale ? "Not responding" : session.statusLabel;
    el.statePill.className =
      "pill " +
      (state.stale
        ? "pill--error"
        : session.status === "running"
          ? "pill--running"
          : session.status === "paused"
            ? "pill--paused"
            : "pill--idle");

    el.readout.className =
      "readout" +
      (state.stale ? " is-stale" : session.status === "ready" ? " is-idle" : "");

    el.primary.textContent = primaryLabel(session);
    el.primary.disabled = state.busy || state.stale;
    el.lap.disabled = state.busy || state.stale || !session.canLap;
    el.reset.disabled = state.busy || state.stale || !session.canReset;

    el.recoveredNote.hidden = !session.recovered;
    el.labelInput.disabled = state.busy || state.stale;
    el.labelSave.disabled = state.busy || state.stale;
    if (!state.labelDirty) el.labelInput.value = session.label || "";

    renderLaps(session);
    state.lastRenderedElapsed = null;
    state.lastRenderedSplit = null;
    paintReadout();
    startTicking();
  }

  function announce(message) {
    el.announcer.textContent = message;
  }

  function announceTransition(session) {
    if (state.lastStatus === null) {
      state.lastStatus = session.status;
      state.lastLapCount = session.lapCount;
      return;
    }
    if (session.lapCount > state.lastLapCount && session.laps.length) {
      var newest = session.laps[0];
      announce(
        newest.name + " recorded. Split " + newest.split + ", total " + newest.total + "."
      );
    } else if (session.status !== state.lastStatus) {
      if (session.status === "running") {
        announce("Stopwatch running.");
      } else if (session.status === "paused") {
        announce("Stopwatch paused at " + session.elapsed + ".");
      } else {
        announce("Stopwatch reset.");
      }
    } else if (session.lapCount === 0 && state.lastLapCount > 0) {
      announce("Stopwatch reset.");
    }
    state.lastStatus = session.status;
    state.lastLapCount = session.lapCount;
  }

  /* ── service ─────────────────────────────────────────────────────────── */

  function adopt(session) {
    state.session = session;
    // Anchor before any awaits so the offset cannot include our own latency.
    state.anchorPerf = performance.now();
    state.anchorElapsedMs = session.elapsedMs;
    state.anchorPendingMs = session.pendingSplitMs;
    state.stale = false;
    hideError();
    announceTransition(session);
    render();
    schedulePoll();
  }

  function showError(message) {
    // Freeze the last displayed estimate until a fresh server snapshot arrives.
    state.anchorElapsedMs = currentElapsedMs();
    state.anchorPendingMs = currentPendingMs();
    state.anchorPerf = performance.now();
    state.stale = true;
    el.errorMessage.textContent = message;
    el.errorRegion.hidden = false;
    stopTicking();
    if (state.session) render();
    else {
      el.primary.disabled = true;
      el.lap.disabled = true;
      el.reset.disabled = true;
      el.stateWord.textContent = "Not responding";
      el.statePill.className = "pill pill--error";
    }
  }

  function hideError() {
    el.errorRegion.hidden = true;
    el.errorMessage.textContent = "";
  }

  var requestGeneration = 0;

  function request(path, method, body) {
    var controller = new AbortController();
    var deadline = setTimeout(function () { controller.abort(); }, 8000);
    return fetch(path, {
      signal: controller.signal,
      body: method === "POST" ? JSON.stringify(body || (path === "/api/session/reset" ? { confirmed: true } : {})) : undefined,
      method: method || "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          throw new Error("Stopwatch service returned an unreadable response.");
        })
        .then(function (payload) {
          if (!response.ok) {
            throw new Error(payload.error || "Stopwatch service returned an error.");
          }
          return payload;
        });
    }).catch(function (error) {
      if (error.name === "AbortError") throw new Error("Stopwatch did not respond within eight seconds. Retry to refresh the session.");
      if (error instanceof TypeError) throw new Error("Connection lost. The displayed time is held until you reconnect. Retry to refresh the session.");
      throw error;
    }).finally(function () { clearTimeout(deadline); });
  }

  function refresh() {
    if (state.busy) return Promise.resolve();
    var generation = ++requestGeneration;
    return request("/api/session")
      .then(function (session) { if (generation === requestGeneration) adopt(session); })
      .catch(function (error) {
        if (generation !== requestGeneration) return;
        showError(error.message || "Cannot reach the Stopwatch service.");
        schedulePoll();
      });
  }

  function command(path, body) {
    if (state.busy) return Promise.resolve();
    ++requestGeneration; // A prior GET must never overwrite this command result.
    if (state.pollTimer !== null) clearTimeout(state.pollTimer);
    state.busy = true;
    if (state.session) render();
    return request(path, "POST", body)
      .then(function (payload) {
        if (path === "/api/session/label" || path === "/api/session/reset") state.labelDirty = false;
        adopt(payload.session);
        if (path === "/api/session/label") announce("Session name saved.");
      })
      .catch(function (error) {
        showError(error.message || "That action did not complete.");
      })
      .then(function () {
        state.busy = false;
        schedulePoll();
        if (state.session && !state.stale) render();
      });
  }

  function schedulePoll() {
    if (state.pollTimer !== null) clearTimeout(state.pollTimer);
    var delay =
      state.session && state.session.running ? POLL_RUNNING_MS : POLL_IDLE_MS;
    state.pollTimer = setTimeout(function () {
      if (document.visibilityState === "hidden") {
        schedulePoll();
        return;
      }
      refresh();
    }, delay);
  }

  /* ── intent ──────────────────────────────────────────────────────────── */

  function togglePrimary() {
    if (!state.session || state.busy || state.stale) return;
    command(
      state.session.status === "running" ? "/api/session/pause" : "/api/session/start"
    );
  }

  function recordLap() {
    if (!state.session || state.busy || state.stale || !state.session.canLap) return;
    command("/api/session/lap");
  }

  function askReset() {
    if (!state.session || state.busy || state.stale || !state.session.canReset) return;
    var count = state.session.lapCount;
    el.dialogCount.textContent = count
      ? count === 1
        ? "1 recorded lap"
        : "all " + count + " recorded laps"
      : "any recorded laps";
    if (typeof el.dialog.showModal === "function") {
      el.dialog.showModal();
    } else {
      // Ancient browser without <dialog>: still require a second, explicit press.
      el.reset.textContent = "Confirm reset";
      el.reset.dataset.armed = "true";
    }
  }

  el.labelInput.addEventListener("input", function () { state.labelDirty = true; });
  el.labelForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!state.session || state.busy || state.stale) return;
    command("/api/session/label", { label: el.labelInput.value });
  });

  el.primary.addEventListener("click", togglePrimary);
  el.lap.addEventListener("click", recordLap);
  el.reset.addEventListener("click", function () {
    if (el.reset.dataset.armed === "true") {
      delete el.reset.dataset.armed;
      el.reset.textContent = "Reset";
      command("/api/session/reset");
      return;
    }
    askReset();
  });
  el.retry.addEventListener("click", function () {
    hideError();
    refresh();
  });

  el.dialog.addEventListener("close", function () {
    if (el.dialog.returnValue === "confirm") command("/api/session/reset");
    el.dialog.returnValue = "";
    el.reset.focus();
  });

  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (el.dialog.open) return;
    var target = event.target;
    if (
      target &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
    ) {
      return;
    }
    // Let Enter and Space act on a focused button normally.
    if (event.key === " " && target && target.tagName === "BUTTON") return;

    var key = event.key.toLowerCase();
    if (event.key === " " || key === "k") {
      event.preventDefault();
      togglePrimary();
    } else if (key === "l") {
      event.preventDefault();
      recordLap();
    } else if (key === "r") {
      event.preventDefault();
      askReset();
    }
  });

  document.addEventListener("visibilitychange", function () {
    // Animation frames are throttled in background tabs, so re-anchor from the
    // service on return instead of trusting an accumulated local count.
    if (document.visibilityState === "visible") refresh();
  });

  reducedMotion.addEventListener("change", startTicking);

  refresh();
})();
