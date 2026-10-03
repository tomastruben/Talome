export type AssistantEntityKind =
  | "automation"
  | "container"
  | "media"
  | "audiobook"
  | "app";

export interface AssistantEntityReference {
  kind: AssistantEntityKind;
  label: string;
  id?: string;
  href?: string;
  mediaType?: "movie" | "tv";
  year?: number;
}

export interface AssistantToolResult {
  toolName: string;
  output: unknown;
  input?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseOutput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
}

function normalizeReferenceLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function pushReference(
  references: AssistantEntityReference[],
  reference: AssistantEntityReference,
) {
  if (!reference.label.trim()) return;
  const normalized = normalizeReferenceLabel(reference.label);
  const duplicate = references.some((candidate) =>
    candidate.kind === reference.kind
    && normalizeReferenceLabel(candidate.label) === normalized
    && (candidate.id ?? "") === (reference.id ?? "")
  );
  if (!duplicate) references.push(reference);
}

function addAutomationReferences(
  references: AssistantEntityReference[],
  output: unknown,
  input: unknown,
) {
  const outputRecord = asRecord(output);
  const inputRecord = asRecord(input);
  const rows = Array.isArray(output)
    ? recordList(output)
    : recordList(outputRecord?.automations);

  for (const row of rows) {
    const id = stringValue(row.id);
    const label = stringValue(row.name);
    if (id && label) {
      pushReference(references, {
        kind: "automation",
        id,
        label,
        href: `/dashboard/automations?id=${encodeURIComponent(id)}`,
      });
    }
  }

  const id = stringValue(outputRecord?.id) ?? stringValue(inputRecord?.id);
  const label = stringValue(outputRecord?.name) ?? stringValue(inputRecord?.name);
  if (id && label) {
    pushReference(references, {
      kind: "automation",
      id,
      label,
      href: `/dashboard/automations?id=${encodeURIComponent(id)}`,
    });
  }
}

function addContainerReferences(
  references: AssistantEntityReference[],
  output: unknown,
  input: unknown,
) {
  const outputRecord = asRecord(output);
  const inputRecord = asRecord(input);
  const rows = recordList(outputRecord?.containers);
  for (const row of rows) {
    const label = stringValue(row.displayName) ?? stringValue(row.name);
    if (label) pushReference(references, { kind: "container", label, id: stringValue(row.id) ?? label });
  }

  const label = stringValue(outputRecord?.containerId)
    ?? stringValue(inputRecord?.containerId)
    ?? stringValue(inputRecord?.name);
  if (label) pushReference(references, { kind: "container", label, id: label });
}

function addMediaRow(
  references: AssistantEntityReference[],
  row: Record<string, unknown>,
  mediaType?: "movie" | "tv",
  labelField: "title" | "series" = "title",
) {
  const label = stringValue(row[labelField]);
  if (!label) return;
  pushReference(references, {
    kind: "media",
    label,
    mediaType,
    year: numberValue(row.year),
  });
}

function addMediaReferences(
  references: AssistantEntityReference[],
  toolName: string,
  output: unknown,
  input: unknown,
) {
  const outputRecord = asRecord(output);
  const inputRecord = asRecord(input);

  for (const row of recordList(outputRecord?.movies)) {
    addMediaRow(references, row, "movie");
  }
  for (const row of recordList(outputRecord?.tv)) {
    addMediaRow(references, row, "tv");
  }
  for (const row of recordList(outputRecord?.episodes)) {
    addMediaRow(references, row, "tv", "series");
  }

  if (toolName === "request_media") {
    const label = stringValue(inputRecord?.title);
    const type = inputRecord?.type === "movie" || inputRecord?.type === "tv"
      ? inputRecord.type
      : undefined;
    if (label) pushReference(references, { kind: "media", label, mediaType: type });
  }
}

function addAudiobookReferences(
  references: AssistantEntityReference[],
  output: unknown,
) {
  const outputRecord = asRecord(output);
  const rows = recordList(outputRecord?.items);
  const single = asRecord(outputRecord?.item);
  if (single) rows.push(single);

  for (const row of rows) {
    const id = stringValue(row.id);
    const label = stringValue(row.title);
    if (id && label) {
      pushReference(references, {
        kind: "audiobook",
        id,
        label,
        href: `/dashboard/audiobooks/${encodeURIComponent(id)}`,
      });
    }
  }
}

function addAppReferences(
  references: AssistantEntityReference[],
  output: unknown,
) {
  for (const row of recordList(output)) {
    const id = stringValue(row.id);
    const storeId = stringValue(row.storeId);
    const label = stringValue(row.name);
    if (id && storeId && label) {
      pushReference(references, {
        kind: "app",
        id,
        label,
        href: `/dashboard/apps/${encodeURIComponent(storeId)}/${encodeURIComponent(id)}`,
      });
    }
  }
}

const AUTOMATION_TOOLS = new Set([
  "list_automations",
  "create_automation",
  "update_automation",
  "get_automation_runs",
]);
const CONTAINER_TOOLS = new Set([
  "list_containers",
  "get_container_logs",
  "check_service_health",
  "inspect_container",
  "start_container",
  "stop_container",
  "restart_container",
]);
const MEDIA_TOOLS = new Set([
  "get_library",
  "search_media",
  "request_media",
  "get_calendar",
]);
const APP_TOOLS = new Set(["list_apps", "search_apps"]);

export function extractAssistantEntityReferences(
  toolResults: AssistantToolResult[],
): AssistantEntityReference[] {
  const references: AssistantEntityReference[] = [];

  for (const result of toolResults) {
    const output = parseOutput(result.output);
    if (AUTOMATION_TOOLS.has(result.toolName)) {
      addAutomationReferences(references, output, result.input);
    }
    if (CONTAINER_TOOLS.has(result.toolName)) {
      addContainerReferences(references, output, result.input);
    }
    if (MEDIA_TOOLS.has(result.toolName)) {
      addMediaReferences(references, result.toolName, output, result.input);
    }
    if (result.toolName.startsWith("audiobookshelf_")) {
      addAudiobookReferences(references, output);
    }
    if (APP_TOOLS.has(result.toolName)) {
      addAppReferences(references, output);
    }
  }

  return references;
}

export function findAssistantEntityReference(
  label: string,
  references: AssistantEntityReference[],
): AssistantEntityReference | undefined {
  const normalized = normalizeReferenceLabel(label);
  if (!normalized) return undefined;
  return references.find((reference) =>
    normalizeReferenceLabel(reference.label) === normalized
    || (reference.kind === "container" && !!reference.id && normalizeReferenceLabel(reference.id) === normalized)
  );
}
