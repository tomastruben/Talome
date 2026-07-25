import { and, eq } from "drizzle-orm";
import type {
  TalomeAppAction,
  TalomeAppSpec,
  TalomeAppSpecStatus,
  TalomeDataSource,
} from "@talome/types";
import { db, schema } from "../db/index.js";
import { writeAuditEntry } from "../db/audit.js";
import { executeAppApiRequest } from "../ai/tools/universal-tools.js";
import { restartApp, startApp, stopApp } from "../stores/lifecycle.js";
import { TalomeAppSpecSchema } from "./schema.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BLOCKED_TALOME_PREFIXES = [
  "/api/auth",
  "/api/users",
  "/api/settings",
  "/api/tools",
  "/api/mcp",
  "/api/terminal",
  "/api/evolution",
  "/api/app-specs",
];

export interface StoredAppSpec {
  id: string;
  appId: string;
  storeId: string;
  schemaVersion: number;
  revision: number;
  status: TalomeAppSpecStatus;
  spec: TalomeAppSpec;
  createdAt: string;
  updatedAt: string;
}

function appSpecId(storeId: string, appId: string) {
  return `${storeId}:${appId}`;
}

function rowToStored(row: typeof schema.appSpecs.$inferSelect): StoredAppSpec | null {
  try {
    const spec = TalomeAppSpecSchema.parse(JSON.parse(row.specJson));
    return {
      id: row.id,
      appId: row.appId,
      storeId: row.storeSourceId,
      schemaVersion: row.schemaVersion,
      revision: row.revision,
      status: row.status as TalomeAppSpecStatus,
      spec,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    return null;
  }
}

export function getStoredAppSpec(
  storeId: string,
  appId: string,
  options: { includeInactive?: boolean } = {},
): StoredAppSpec | null {
  const row = db
    .select()
    .from(schema.appSpecs)
    .where(and(
      eq(schema.appSpecs.storeSourceId, storeId),
      eq(schema.appSpecs.appId, appId),
    ))
    .get();
  if (!row || (!options.includeInactive && row.status !== "approved")) return null;
  return rowToStored(row);
}

export function listStoredAppSpecs(options: { includeInactive?: boolean } = {}): StoredAppSpec[] {
  const rows = db.select().from(schema.appSpecs).all();
  return rows.flatMap((row) => {
    if (!options.includeInactive && row.status !== "approved") return [];
    const stored = rowToStored(row);
    return stored ? [stored] : [];
  });
}

export function saveAppSpec(input: {
  storeId: string;
  spec: TalomeAppSpec;
  status?: TalomeAppSpecStatus;
}): StoredAppSpec {
  const existing = getStoredAppSpec(input.storeId, input.spec.appId, { includeInactive: true });
  const spec = TalomeAppSpecSchema.parse({
    ...input.spec,
    revision: existing
      ? Math.max(input.spec.revision, existing.revision + 1)
      : input.spec.revision,
  });
  const serialized = JSON.stringify(spec);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("AppSpec exceeds the 2 MB safety limit");
  }

  const now = new Date().toISOString();
  const id = appSpecId(input.storeId, spec.appId);
  const status = input.status ?? "draft";
  db.insert(schema.appSpecs).values({
    id,
    appId: spec.appId,
    storeSourceId: input.storeId,
    schemaVersion: spec.schemaVersion,
    revision: spec.revision,
    status,
    specJson: serialized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: schema.appSpecs.id,
    set: {
      schemaVersion: spec.schemaVersion,
      revision: spec.revision,
      status,
      specJson: serialized,
      updatedAt: now,
    },
  }).run();

  writeAuditEntry("app_spec_saved", "modify", `${id} r${spec.revision} ${status}`);
  return getStoredAppSpec(input.storeId, spec.appId, { includeInactive: true })!;
}

export function deleteAppSpec(storeId: string, appId: string): void {
  db.delete(schema.appSpecs).where(and(
    eq(schema.appSpecs.storeSourceId, storeId),
    eq(schema.appSpecs.appId, appId),
  )).run();
  writeAuditEntry("app_spec_deleted", "destructive", appSpecId(storeId, appId));
}

function ensureSafeTalomePath(path: string): void {
  if (!path.startsWith("/api/") || path.includes("://") || path.includes("..")) {
    throw new Error("AppSpec contains an unsafe Talome API path");
  }
  if (BLOCKED_TALOME_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error("AppSpec cannot access this protected Talome API");
  }
}

async function parseResponse(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("App data response exceeds 2 MB");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("App data response exceeds 2 MB");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("App data source returned invalid JSON");
    }
  }
  return text;
}

async function executeTalomeHttp(input: {
  method: string;
  path: string;
  body?: unknown;
  cookie?: string;
}) {
  ensureSafeTalomePath(input.path);
  const port = Number(process.env.CORE_PORT) || 4000;
  const response = await fetch(`http://127.0.0.1:${port}${input.path}`, {
    method: input.method,
    headers: {
      "Content-Type": "application/json",
      ...(input.cookie ? { Cookie: input.cookie } : {}),
    },
    body: input.body !== undefined && input.method !== "GET" ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(message.slice(0, 1000) || `Talome API returned ${response.status}`);
  }
  return data;
}

export async function executeAppSpecDataSource(input: {
  storeId: string;
  appId: string;
  dataSourceId: string;
  cookie?: string;
}) {
  const stored = getStoredAppSpec(input.storeId, input.appId);
  if (!stored) throw new Error("Approved AppSpec not found");
  const source = stored.spec.dataSources.find((candidate) => candidate.id === input.dataSourceId);
  if (!source) throw new Error("Data source not found");

  if (source.kind === "static") return source.value;
  if (source.kind === "talome-api") {
    return executeTalomeHttp({ method: "GET", path: source.path, cookie: input.cookie });
  }

  const result = await executeAppApiRequest({
    appId: source.appId,
    method: "GET",
    path: source.path,
    timeoutMs: 15_000,
  });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function validateActionInput(action: TalomeAppAction, raw: unknown): Record<string, string | number | boolean> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const declared = new Map((action.input ?? []).map((field) => [field.id, field]));
  const unexpected = Object.keys(value).find((key) => !declared.has(key));
  if (unexpected) throw new Error(`Unexpected action input: ${unexpected}`);

  const result: Record<string, string | number | boolean> = {};
  for (const field of action.input ?? []) {
    const candidate = value[field.id];
    if (candidate === undefined || candidate === null || candidate === "") {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    if (typeof candidate !== field.type) throw new Error(`${field.label} must be ${field.type}`);
    result[field.id] = candidate as string | number | boolean;
  }
  return result;
}

const INPUT_TOKEN = /\{\{([a-zA-Z0-9._:-]+)\}\}/g;

function renderString(
  template: string,
  input: Record<string, string | number | boolean>,
  encode: boolean,
) {
  return template.replace(INPUT_TOKEN, (_, key: string) => {
    if (!(key in input)) throw new Error(`Missing template input: ${key}`);
    const value = String(input[key]);
    return encode ? encodeURIComponent(value) : value;
  });
}

function renderBodyTemplate(
  template: unknown,
  input: Record<string, string | number | boolean>,
): unknown {
  if (typeof template === "string") {
    const exact = template.match(/^\{\{([a-zA-Z0-9._:-]+)\}\}$/);
    if (exact) {
      if (!(exact[1] in input)) throw new Error(`Missing template input: ${exact[1]}`);
      return input[exact[1]];
    }
    return renderString(template, input, false);
  }
  if (Array.isArray(template)) return template.map((value) => renderBodyTemplate(value, input));
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, renderBodyTemplate(value, input)]),
    );
  }
  return template;
}

async function executeTrustedLifecycleAction(action: Extract<TalomeAppAction, { kind: "talome-api" }>) {
  const match = action.path.match(/^\/api\/apps\/[^/]+\/([^/]+)\/(start|stop|restart)$/);
  if (!match || action.method !== "POST") {
    throw new Error("This Talome API action must be run from the authenticated app surface");
  }
  const appId = decodeURIComponent(match[1]);
  const operation = match[2];
  const result = operation === "start"
    ? await startApp(appId)
    : operation === "stop"
      ? await stopApp(appId)
      : await restartApp(appId);
  if (!result.success) throw new Error(result.error ?? `Failed to ${operation} ${appId}`);
  return { ok: true, operation, appId };
}

export async function executeAppSpecAction(input: {
  storeId: string;
  appId: string;
  actionId: string;
  values?: unknown;
  confirmed?: boolean;
  cookie?: string;
  trusted?: boolean;
}) {
  const stored = getStoredAppSpec(input.storeId, input.appId);
  if (!stored) throw new Error("Approved AppSpec not found");
  const action = stored.spec.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) throw new Error("Action not found");
  const values = validateActionInput(action, input.values);

  const confirmation = "confirmation" in action ? action.confirmation : undefined;
  if (confirmation && !input.confirmed) {
    return { ok: false as const, requiresConfirmation: true as const, confirmation };
  }

  if (action.kind === "assistant") {
    return {
      ok: true as const,
      kind: "assistant" as const,
      prompt: `${stored.spec.assistant.context}\n\n${renderString(action.prompt, values, false)}`,
    };
  }

  const path = renderString(action.path, values, true);
  const body = action.bodyTemplate === undefined
    ? undefined
    : renderBodyTemplate(action.bodyTemplate, values);

  let data: unknown;
  if (action.kind === "app-api") {
    const result = await executeAppApiRequest({
      appId: action.appId!,
      method: action.method,
      path,
      body,
      timeoutMs: 15_000,
    });
    if (!result.success) throw new Error(result.error);
    data = result.data;
  } else if (input.trusted) {
    data = await executeTrustedLifecycleAction({ ...action, path });
  } else {
    data = await executeTalomeHttp({
      method: action.method,
      path,
      body,
      cookie: input.cookie,
    });
  }

  writeAuditEntry(
    `app_spec_action:${input.actionId}`,
    action.destructive ? "destructive" : "modify",
    `${input.storeId}:${input.appId}`,
  );
  return { ok: true as const, kind: "result" as const, data };
}

export function getDataSourceRefreshMs(source: TalomeDataSource) {
  return source.kind === "static" ? 0 : source.refreshMs ?? 30_000;
}
