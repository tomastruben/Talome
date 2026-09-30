/** Independent native-renderer check. Every API/action is intercepted; no app service is exercised. */
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const input = JSON.parse(process.argv[2] ? await readFile(process.argv[2], "utf8") : await new Promise((resolve, reject) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { text += chunk; }); process.stdin.on("end", () => resolve(text)); process.stdin.on("error", reject); }));
const { spec, dashboardRoot, outputDir, binding } = input;
await mkdir(outputDir, { recursive: true });
const report = { version: 1, scope: "native-renderer-fixture", binding, generatedAt: new Date().toISOString(), status: "failed", checks: [], screenshots: [], unverified: ["Generated application backend, external UI, real service data, and real action side effects", "Visual design quality, contrast ratios, and full accessibility conformance"] };
let server;
let browser;
let page;
process.on("SIGTERM", async () => {
  server?.kill("SIGKILL");
  const forceExit = setTimeout(() => process.exit(143), 2000);
  await browser?.close().catch(() => {});
  clearTimeout(forceExit);
  process.exit(143);
});
const check = (id, details, status = "passed") => report.checks.push({ id, status, details });

function getValue(object, path) {
  if (!path) return object;
  return path.split(".").reduce((value, key) => value && typeof value === "object" && !["__proto__", "constructor", "prototype"].includes(key) ? value[key] : undefined, object);
}

function setValue(object, path, value) {
  if (!path) return;
  const keys = path.split(".");
  if (keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) return;
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

function fixtureData(sourceId, state, revision) {
  if (state === "empty") return {};
  let data = {};
  // Compose shared response paths so one chart does not erase another chart's
  // series. Chart observations are applied after generic table/list fields.
  const blocks = spec.surfaces.flatMap((surface) => surface.blocks).filter((block) => block.dataSource === sourceId)
    .sort((a, b) => Number(a.component === "time-series") - Number(b.component === "time-series"));
  for (const block of blocks) {
    const amount = revision ? 84 : 42;
    if (block.component === "stat" || block.component === "progress") {
      setValue(data, block.valuePath, block.format === "text" ? "Fixture ready" : amount);
      setValue(data, block.detailPath, "Deterministic browser fixture");
      setValue(data, block.maxPath, 100);
      setValue(data, block.progressValuePath, amount);
      setValue(data, block.progressMaxPath, 100);
    } else if (block.component === "markdown") {
      setValue(data, block.contentPath, "Independent native browser fixture.");
    } else if (["list", "table", "activity-list", "time-series", "comparison-bars"].includes(block.component)) {
      const path = block.rowsPath ?? block.itemsPath;
      const existing = getValue(data, path);
      const previousRows = Array.isArray(existing) ? existing : [];
      const length = Math.max(previousRows.length, block.component === "time-series" ? 5 : 2);
      const rows = Array.from({ length }, (_, index) => {
        const row = { ...previousRows[index] };
        setValue(row, block.titlePath, `Fixture item ${index + 1}`);
        setValue(row, block.descriptionPath, "Validation record");
        setValue(row, block.datePath, `2026-01-0${index + 1}`);
        setValue(row, block.xPath, `2026-01-0${index + 1}`);
        setValue(row, block.labelPath, `Fixture category ${index + 1}`);
        setValue(row, block.valuePath, amount);
        setValue(row, block.plannedPath, 100);
        setValue(row, block.actualPath, amount);
        setValue(row, block.rowAction?.valuePath, `fixture-${index}`);
        for (const column of block.columns ?? []) setValue(row, column.path, column.format && column.format !== "text" ? amount : `Fixture ${index + 1}`);
        for (const [seriesIndex, series] of (block.series ?? []).entries()) {
          const value = [amount, 0, null, -amount / 2, amount * 2][index % 5];
          setValue(row, series.valuePath, value === null ? null : value * (seriesIndex + 1));
        }
        return row;
      });
      if (path) setValue(data, path, rows);
      else data = rows;
    }
  }
  return data;
}

try {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let serverOutput = "";
  server = spawn(process.execPath, [join(dashboardRoot, ".next/standalone/apps/dashboard/server.js")], {
    cwd: dashboardRoot,
    env: { PATH: process.env.PATH, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (value) => { serverOutput = (serverOutput + value).slice(-2000); });
  server.stderr.on("data", (value) => { serverOutput = (serverOutput + value).slice(-2000); });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${origin}/favicon.ico`)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(`Isolated dashboard stopped: ${serverOutput}`);
    await delay(250);
  }
  if (!ready) throw new Error(`Isolated dashboard did not start: ${serverOutput}`);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block" });
  // This fixture cookie only permits the isolated HTML shell. Every API is intercepted below.
  await context.addCookies([{ name: "talome_session", value: "native-renderer-fixture", url: origin }]);
  await context.routeWebSocket("**/*", (socket) => socket.close());
  let state = "populated";
  let revision = 0;
  let dataRequests = 0;
  const actions = [];
  let releaseAction;
  const unexpected = [];
  let blockedExternal = 0;
  const apiBase = `/api/app-specs/user-apps/${encodeURIComponent(spec.appId)}`;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin) { blockedExternal++; return route.abort("blockedbyclient"); }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/auth/me") return json({ authenticated: true, userId: "native-browser-fixture", username: "Validation", role: "admin" });
      if (url.pathname === "/api/ai/models") return json({ providers: [], activeProvider: "none" });
      if (url.pathname === apiBase) return json({ appId: spec.appId, storeId: "user-apps", revision: spec.revision, status: "approved", spec });
      if (url.pathname.startsWith(`${apiBase}/data/`)) {
        dataRequests++;
        if (state === "error") return json({ error: "Isolated fixture unavailable" }, 503);
        return json({ data: fixtureData(decodeURIComponent(url.pathname.split("/").at(-1)), state, revision) });
      }
      if (url.pathname.startsWith(`${apiBase}/actions/`)) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1));
        const action = spec.actions.find((candidate) => candidate.id === id);
        if (!action || action.destructive || request.method() !== "POST") { unexpected.push(`${request.method()} ${url.pathname}`); return json({ ok: false }, 400); }
        actions.push({ id, method: request.method(), body: request.postDataJSON() });
        revision++;
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 5000);
          releaseAction = () => { clearTimeout(timeout); resolve(); };
        });
        return json(action.kind === "assistant" ? { ok: true, kind: "assistant", prompt: action.prompt } : { ok: true, kind: "result" });
      }
      if (request.method() !== "GET") unexpected.push(`${request.method()} ${url.pathname}`);
      return json([]);
    }
    if (url.pathname === "/__native-validation") {
      return route.fulfill({ contentType: "text/html", body: `<html><title>Talome native validation</title><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><script>window.handoffs=[];addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='talome:desktop-open-route-message')window.handoffs.push(e.data.url)})</script><iframe title="Native app" src="/dashboard/native-apps/user-apps/${encodeURIComponent(spec.appId)}"></iframe></html>` });
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text()); });
  page.setDefaultTimeout(7000);
  const load = async () => {
    await page.goto(`${origin}/__native-validation`, { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: spec.name, exact: true })).toBeVisible();
    await expect(frame.locator('[data-slot="skeleton"]')).toHaveCount(0);
    return frame;
  };
  for (const viewport of [{ width: 390, height: 844 }, { width: 480, height: 800 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    const frame = await load();
    for (const [index, surface] of spec.surfaces.entries()) {
      if (spec.surfaces.length > 1) {
        const tab = frame.getByRole("tab", { name: surface.title, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await tab.focus();
        await tab.press("ArrowRight");
        await expect(frame.getByRole("tab", { name: spec.surfaces[(index + 1) % spec.surfaces.length].title, exact: true })).toBeFocused();
        await tab.click();
      }
      const body = frame.locator("body");
      const nativeSurface = frame.locator(`[data-native-surface=${JSON.stringify(surface.id)}]`);
      await expect(nativeSurface).toBeVisible();
      for (const block of surface.blocks) {
        const rendered = nativeSurface.locator(`[data-native-block=${JSON.stringify(block.id)}]`);
        await expect(rendered).toHaveCount(1);
        if (!(await rendered.innerText()).trim()) throw new Error(`Block ${surface.id}/${block.id} rendered no content.`);
        if (block.component === "time-series") {
          const chart = rendered.locator("[data-native-chart]");
          await expect(chart).toHaveCount(1);
          // A nonblank card title is insufficient: populated charts need actual
          // drawing geometry and a keyboard-accessible alternative to hover.
          const source = spec.dataSources.find((candidate) => candidate.id === block.dataSource);
          const data = source?.kind === "static" ? source.value : fixtureData(block.dataSource, state, revision);
          const sourceRows = getValue(data, block.rowsPath);
          const rows = Array.isArray(sourceRows) ? sourceRows.filter((row) => row && typeof row === "object").slice(-(block.limit ?? 100)) : [];
          const isMeasurement = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value));
          const numericSeries = block.series.filter((series) => rows.some((row) => isMeasurement(getValue(row, series.valuePath))));
          const hasValues = rows.some((row) => block.series.some((series) => {
            const value = getValue(row, series.valuePath);
            return isMeasurement(value);
          }));
          if (hasValues) {
            await expect(chart.locator("svg.recharts-surface")).toBeVisible();
            const geometry = await chart.locator("svg.recharts-surface").evaluate((svg) => ({
              width: svg.getBoundingClientRect().width,
              height: svg.getBoundingClientRect().height,
              marks: [...svg.querySelectorAll(".recharts-line-curve,.recharts-area-curve,.recharts-rectangle,.recharts-dot")].filter((mark) => {
                const box = mark.getBBox();
                return box.width > 0 || box.height > 0;
              }).length,
              invalid: [...svg.querySelectorAll("path")].some((mark) => /NaN|Infinity/.test(mark.getAttribute("d") ?? "")),
              series: [...svg.querySelectorAll("g.recharts-line,g.recharts-area,g.recharts-bar")].filter((group) => group.querySelector(".recharts-line-curve,.recharts-area-curve,.recharts-rectangle,.recharts-dot")).length,
            }));
            if (!geometry.width || !geometry.height || !geometry.marks || geometry.invalid || geometry.series < numericSeries.length) throw new Error(`Chart ${surface.id}/${block.id} has missing or invalid series drawing geometry.`);
          } else {
            await expect(chart).toContainText(/No (?:history|numeric|chart|readings|data|observations)/i);
          }
          const disclosure = chart.locator("summary");
          if (await disclosure.count()) {
            await disclosure.focus();
            await disclosure.press("Enter");
            const table = chart.getByRole("table", { name: `${block.title} data`, exact: true });
            await expect(table).toBeVisible();
            const headings = (await table.getByRole("columnheader").allTextContents()).join(" | ");
            for (const series of block.series) expect(headings).toContain(series.label);
            await expect(table.getByRole("row")).toHaveCount(rows.length + 1);
            for (const [rowIndex, row] of rows.entries()) {
              const cells = table.getByRole("row").nth(rowIndex + 1).getByRole("cell");
              for (const [seriesIndex, series] of block.series.entries()) {
                const value = getValue(row, series.valuePath);
                if (!isMeasurement(value)) await expect(cells.nth(seriesIndex)).toHaveText("No data");
                else {
                  await expect(cells.nth(seriesIndex)).not.toContainText("No data");
                  if (!block.valueFormat || ["number", "text"].includes(block.valueFormat)) {
                    const number = block.valueFormat === "text" ? String(Number(value)) : new Intl.NumberFormat("en-US").format(Number(value));
                    await expect(cells.nth(seriesIndex)).toHaveText(`${number}${block.unit ? ` ${block.unit}` : ""}`);
                  }
                }
              }
            }
            await disclosure.press("Enter");
          } else if (hasValues) throw new Error(`Chart ${surface.id}/${block.id} lacks its accessible data disclosure.`);
          check(`chart:${viewport.width}:${surface.id}:${block.id}`, `${block.variant ?? "line"}: ${hasValues ? "visible chart marks, finite geometry and keyboard-accessible series data" : "explicit no-data state"}; missing fixture readings retain their missing representation.`);
        }
      }
      const nativeGeometry = await nativeSurface.evaluate((element) => ({ width: element.clientWidth, content: element.scrollWidth }));
      if (nativeGeometry.content > nativeGeometry.width + 2) throw new Error(`Surface ${surface.id} has clipped horizontal content at ${viewport.width}px.`);
      await expect(body).not.toContainText("Application error");
      const geometry = await body.evaluate((element) => ({ dark: document.documentElement.classList.contains("dark"), width: innerWidth, content: document.documentElement.scrollWidth, text: element.innerText.length }));
      if (!geometry.dark || geometry.text < spec.name.length || geometry.content > geometry.width + 2) throw new Error(`Surface ${surface.id} at ${viewport.width}px failed dark/nonblank/overflow check: ${JSON.stringify(geometry)}`);
      const screenshot = `${viewport.width}-${index}-${surface.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.png`;
      await page.screenshot({ path: join(outputDir, screenshot), fullPage: true });
      report.screenshots.push(screenshot);
      check(`surface:${viewport.width}:${surface.id}`, "Real native renderer: visible content, dark theme, no document overflow; surface tabs respond to pointer and keyboard.");
    }
  }
  // Exercise a rendered action entirely against the intercepted fixture service.
  let exercisedAction = false;
  const frame = page.frameLocator("iframe");
  for (const surface of spec.surfaces) {
    if (spec.surfaces.length > 1) await frame.getByRole("tab", { name: surface.title, exact: true }).click();
    const referenced = [surface.primaryActionId, ...surface.blocks.flatMap((block) => block.actionIds ?? [block.actionId, block.reviewActionId, block.footerActionId])].filter(Boolean);
    const action = spec.actions.find((candidate) => referenced.includes(candidate.id) && !("destructive" in candidate && candidate.destructive));
    if (!action) continue;
    const button = frame.getByRole("button", { name: action.label, exact: true }).first();
    if (!await button.isVisible()) continue;
    const beforeRequests = dataRequests;
    await button.click();
    if (action.input?.some((field) => field.required)) {
      await expect.poll(() => page.evaluate(() => window.handoffs.length)).toBeGreaterThan(0);
      expect(actions).toHaveLength(0);
      const handoffs = await page.evaluate(() => window.handoffs);
      expect(new URL(handoffs.at(-1), origin).searchParams.get("prompt")).toContain(action.label);
      check("action:input-handoff", `${action.id}: required inputs open the Assistant with app context; no real Assistant request sent.`);
    } else {
      if (action.confirmation) await frame.getByRole("dialog").getByRole("button", { name: action.label, exact: true }).click();
      await expect.poll(() => actions.length).toBe(1);
      expect(actions[0]).toEqual({ id: action.id, method: "POST", body: { confirmed: Boolean(action.confirmation), values: {} } });
      await expect(frame.getByRole("button", { name: /Working…/ }).first()).toBeDisabled();
      releaseAction();
      if (action.kind === "assistant") {
        await expect.poll(() => page.evaluate(() => window.handoffs.length)).toBeGreaterThan(0);
        const handoffs = await page.evaluate(() => window.handoffs);
        expect(new URL(handoffs.at(-1), origin).searchParams.get("prompt")).toBe(action.prompt);
        check("action:assistant-handoff", `${action.id}: exact declared POST payload, pending control, and returned assistant prompt handed to desktop; no model request sent.`);
      } else {
        await expect(frame.getByText(`${action.label} completed`, { exact: true })).toBeVisible();
        if (spec.dataSources.some((source) => source.kind !== "static")) await expect.poll(() => dataRequests).toBeGreaterThan(beforeRequests);
        check("action:fixture-result", `${action.id}: exact declared POST payload, disabled pending control, rendered completion feedback${dataRequests > beforeRequests ? " and refreshed source data" : ""}; all responses simulated.`);
      }
    }
    exercisedAction = true;
    break;
  }
  if (!exercisedAction) check("action:fixture-result", "No eligible visible action; backend and action workflow remain unverified.", "skipped");
  const destructive = spec.actions.filter((action) => action.destructive);
  if (destructive.length) {
    let cancelled = false;
    for (const surface of spec.surfaces) {
      if (spec.surfaces.length > 1) await frame.getByRole("tab", { name: surface.title, exact: true }).click();
      const references = [surface.primaryActionId, ...surface.blocks.flatMap((block) => block.actionIds ?? [block.actionId, block.reviewActionId, block.footerActionId])].filter(Boolean);
      const action = destructive.find((candidate) => references.includes(candidate.id) && candidate.confirmation && !candidate.input?.some((field) => field.required));
      if (!action) continue;
      const button = frame.getByRole("button", { name: action.label, exact: true }).first();
      if (!await button.isVisible()) continue;
      const requestCount = actions.length;
      await button.click();
      const dialog = frame.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(action.confirmation);
      expect(actions).toHaveLength(requestCount);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(actions).toHaveLength(requestCount);
      check("action:destructive-confirmation-cancel", `${action.id}: confirmation rendered, Cancel dismissed it, and no destructive action request was issued.`);
      cancelled = true;
      break;
    }
    if (!cancelled) check("action:destructive-confirmation-cancel", "No directly available destructive confirmation flow; destructive execution remains untested.", "skipped");
    expect(actions.some((action) => destructive.some((candidate) => candidate.id === action.id))).toBe(false);
    check("action:destructive-excluded", `${destructive.length} declared destructive action(s) were not invoked; interception rejects them.`);
  }
  if (spec.dataSources.some((source) => source.kind !== "static")) {
    state = "error";
    const errorFrame = await load();
    await expect(errorFrame.getByText("Some app data is unavailable", { exact: true })).toBeVisible();
    state = "populated";
    await errorFrame.getByRole("button", { name: "Retry app data", exact: true }).click();
    await expect(errorFrame.getByText("Some app data is unavailable", { exact: true })).toHaveCount(0);
    check("data:error-recovery", "Injected source failure renders an error; Retry app data recovers without reloading the app.");
    state = "empty";
    const emptyFrame = await load();
    for (const surface of spec.surfaces) {
      if (spec.surfaces.length > 1) await emptyFrame.getByRole("tab", { name: surface.title, exact: true }).click();
      for (const block of surface.blocks.filter((block) => block.component === "time-series" && spec.dataSources.some((source) => source.id === block.dataSource && source.kind !== "static"))) {
        const chart = emptyFrame.locator(`[data-native-surface=${JSON.stringify(surface.id)}] [data-native-block=${JSON.stringify(block.id)}] [data-native-chart]`);
        await expect(chart).toContainText("No observations yet.");
        await expect(chart.locator("svg.recharts-surface")).toHaveCount(0);
      }
    }
    check("data:empty", "Empty fixture response leaves the native application shell usable; dynamic charts explicitly show no observations without fabricated zero marks.");
  } else {
    check("data:error-recovery", "All sources are static; request failure and retry states are not applicable.", "skipped");
    check("data:empty", "Static sources retain the exact contract values; alternate source responses are not applicable.", "skipped");
  }
  const externalBefore = blockedExternal;
  const externalWasBlocked = await page.evaluate(async () => {
    try { await fetch("https://example.invalid/talome-validation-network-probe"); return false; }
    catch { return true; }
  });
  expect(externalWasBlocked).toBe(true);
  expect(blockedExternal).toBeGreaterThan(externalBefore);
  check("network:external-blocked", "An explicit external fetch probe was blocked by the browser route before any network request.");
  if (errors.length) throw new Error(`Browser runtime errors: ${errors.join("; ").slice(0, 1500)}`);
  if (unexpected.length) throw new Error(`Unexpected intercepted mutations: ${unexpected.join("; ")}`);
  check("isolation", "Every browser API and WebSocket intercepted; external browser requests blocked; fixture credentials only; no generated service execution. This is browser request isolation, not an OS network sandbox.");
  check("console", "No runtime exceptions or relevant console errors.");
  report.status = "passed";
} catch (error) {
  check("browser-failure", error instanceof Error ? error.message : String(error), "failed");
  if (page) {
    await page.screenshot({ path: join(outputDir, "failure.png"), fullPage: true }).catch(() => {});
    report.screenshots.push("failure.png");
  }
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
  await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report));
}
