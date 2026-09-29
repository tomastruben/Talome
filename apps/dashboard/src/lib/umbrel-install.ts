/**
 * Umbrel 2.0 install options — mirrors the plan returned by core
 * POST /api/stores/:storeId/apps/:appId/install-plan (stores/umbrel-v2.ts
 * UmbrelV2Plan) and the `umbrel` body accepted by
 * POST /api/apps/:storeId/:appId/install (UmbrelInstallOptionsSchema).
 */

export interface UmbrelFolderSlot {
  id: string;
  name: string;
  note?: string;
  mounts: { service: string; targetPath: string; readOnly: boolean }[];
  defaultSource: string;
  source: string;
  userSelected: boolean;
  /** Default is a shared media/downloads root: mounted read-only unless chosen explicitly. */
  sharedDefault?: boolean;
}

export interface UmbrelEnvironmentPlan {
  name: string;
  services: string[];
  default?: string;
  options?: string[];
  note?: string;
  value?: string;
  origin: "user" | "default" | "none";
}

export interface UmbrelDependencyResolution {
  dependency: string;
  provider: string | null;
  viaImplements: boolean;
  /** Installed apps able to provide the dependency (optional; newer cores only). */
  candidates?: string[];
}

export interface UmbrelInstallPlan {
  supported: boolean;
  unsupportedReason?: string;
  blockers: string[];
  warnings: string[];
  folders: UmbrelFolderSlot[];
  environment: UmbrelEnvironmentPlan[];
  dependencies: UmbrelDependencyResolution[];
  missingDependencies: string[];
}

export interface UmbrelInstallOptions {
  folders?: Record<string, string>;
  environment?: Record<string, string>;
  dataRoot?: string;
  dependencies?: Record<string, string>;
}

export interface UmbrelFormState {
  /** folderAccess id → host folder */
  folders: Record<string, string>;
  /** folderAccess id → explicitly grant write access to a shared default folder */
  folderWrite: Record<string, boolean>;
  /** environment name → value ("" = keep the app's own default) */
  environment: Record<string, string>;
  /** dependency → provider app id ("" = none / automatic) */
  dependencies: Record<string, string>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseFolder(raw: unknown): UmbrelFolderSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const mounts = Array.isArray(r.mounts)
    ? r.mounts.flatMap((m) => {
        if (!m || typeof m !== "object") return [];
        const mm = m as Record<string, unknown>;
        if (typeof mm.targetPath !== "string") return [];
        return [{ service: typeof mm.service === "string" ? mm.service : "", targetPath: mm.targetPath, readOnly: mm.readOnly === true }];
      })
    : [];
  const defaultSource = typeof r.defaultSource === "string" ? r.defaultSource : "";
  return {
    id: r.id,
    name: r.name,
    ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
    mounts,
    defaultSource,
    source: typeof r.source === "string" ? r.source : defaultSource,
    userSelected: r.userSelected === true,
    ...(r.sharedDefault === true ? { sharedDefault: true } : {}),
  };
}

function parseEnvironment(raw: unknown): UmbrelEnvironmentPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const options = stringArray(r.options);
  const origin = r.origin === "user" || r.origin === "default" ? r.origin : "none";
  return {
    name: r.name,
    services: stringArray(r.services),
    ...(typeof r.default === "string" ? { default: r.default } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(typeof r.note === "string" && r.note ? { note: r.note } : {}),
    ...(typeof r.value === "string" ? { value: r.value } : {}),
    origin,
  };
}

function parseDependency(raw: unknown): UmbrelDependencyResolution | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.dependency !== "string") return null;
  const candidates = stringArray(r.candidates);
  return {
    dependency: r.dependency,
    provider: typeof r.provider === "string" && r.provider ? r.provider : null,
    viaImplements: r.viaImplements === true,
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}

/** Parse the install-plan response (`{ appId, storeId, umbrel, plan }`) or a bare plan. */
export function parseInstallPlan(raw: unknown): UmbrelInstallPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const p = (outer.plan && typeof outer.plan === "object" ? outer.plan : outer) as Record<string, unknown>;
  if (typeof p.supported !== "boolean") return null;
  const list = <T,>(value: unknown, parse: (item: unknown) => T | null): T[] =>
    Array.isArray(value) ? value.map(parse).filter((item): item is T => item !== null) : [];
  return {
    supported: p.supported,
    ...(typeof p.unsupportedReason === "string" && p.unsupportedReason ? { unsupportedReason: p.unsupportedReason } : {}),
    blockers: stringArray(p.blockers),
    warnings: stringArray(p.warnings),
    folders: list(p.folders, parseFolder),
    environment: list(p.environment, parseEnvironment),
    dependencies: list(p.dependencies, parseDependency),
    missingDependencies: stringArray(p.missingDependencies),
  };
}

/**
 * Why the app cannot be installed as planned (unsupported, blockers, missing
 * dependencies), or null when it can.
 */
export function installBlockReason(plan: UmbrelInstallPlan | null | undefined): string | null {
  if (!plan) return null;
  if (!plan.supported) return plan.unsupportedReason ?? plan.blockers[0] ?? "This app can't be installed on Talome.";
  if (plan.blockers.length > 0) return plan.blockers.join(" ");
  if (plan.missingDependencies.length > 0) {
    return `Requires ${plan.missingDependencies.join(", ")}. Install ${plan.missingDependencies.length === 1 ? "it" : "them"} first.`;
  }
  return null;
}

const SEVERAL_PROVIDERS = /^Several installed apps provide "(.+?)" \((.+?)\); using "(.+?)"\.$/;

/**
 * Installed apps that can satisfy a dependency. Uses the plan's `candidates`
 * when present; otherwise the resolved provider plus the alternatives core
 * reports in its "Several installed apps provide …" warning.
 */
export function dependencyCandidates(plan: UmbrelInstallPlan, resolution: UmbrelDependencyResolution): string[] {
  const out = new Set<string>();
  if (resolution.provider) out.add(resolution.provider);
  for (const c of resolution.candidates ?? []) out.add(c);
  for (const warning of plan.warnings) {
    const match = SEVERAL_PROVIDERS.exec(warning);
    if (match && match[1] === resolution.dependency) {
      for (const id of match[2].split(",")) {
        const trimmed = id.trim();
        if (trimmed) out.add(trimmed);
      }
    }
  }
  return [...out];
}

/** True when the plan offers choices worth a dialog before installing. */
export function planHasChoices(plan: UmbrelInstallPlan | null | undefined): boolean {
  if (!plan) return false;
  if (plan.folders.length > 0 || plan.environment.length > 0) return true;
  return plan.dependencies.some((d) => dependencyCandidates(plan, d).length > 1);
}

/** Initial form values: folder paths prefilled with the plan's defaults. */
export function planToFormState(plan: UmbrelInstallPlan): UmbrelFormState {
  const folders: Record<string, string> = {};
  const folderWrite: Record<string, boolean> = {};
  for (const slot of plan.folders) {
    folders[slot.id] = slot.source || slot.defaultSource;
    folderWrite[slot.id] = false;
  }
  const environment: Record<string, string> = {};
  for (const env of plan.environment) {
    const initial = env.value ?? env.default ?? "";
    // A select may only hold an allowed option; anything else means "app default".
    environment[env.name] = env.options && !env.options.includes(initial) ? "" : initial;
  }
  const dependencies: Record<string, string> = {};
  for (const dep of plan.dependencies) dependencies[dep.dependency] = dep.provider ?? "";
  return { folders, folderWrite, environment, dependencies };
}

/** Folder validation mirroring the obvious server rules (the server re-validates). */
export function validateHostFolder(path: string): string | null {
  const value = path.trim();
  if (!value) return "Choose a folder";
  if (!value.startsWith("/")) return "Use an absolute path, e.g. /mnt/media";
  if (value.split("/").includes("..")) return "The path must not contain ..";
  if (/[\u0000-\u001f]/.test(value)) return "The path must not contain control characters";
  return null;
}

/** Field errors keyed by `folder:<id>` / `env:<name>`; empty when the form is valid. */
export function validateFormState(plan: UmbrelInstallPlan, state: UmbrelFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const slot of plan.folders) {
    const error = validateHostFolder(state.folders[slot.id] ?? "");
    if (error) errors[`folder:${slot.id}`] = error;
  }
  for (const env of plan.environment) {
    const value = state.environment[env.name] ?? "";
    if (value && env.options && !env.options.includes(value)) {
      errors[`env:${env.name}`] = `Choose one of: ${env.options.join(", ")}`;
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) errors[`env:${env.name}`] = "Line breaks and control characters are not allowed";
  }
  return errors;
}

/**
 * The `umbrel` install options to send: only what the user actually changed
 * (plus explicit write access to a shared default folder), so untouched
 * fields keep the server's safe defaults. Returns undefined when nothing
 * changed.
 */
export function formStateToOptions(plan: UmbrelInstallPlan, state: UmbrelFormState): UmbrelInstallOptions | undefined {
  const initial = planToFormState(plan);
  const options: UmbrelInstallOptions = {};

  const folders: Record<string, string> = {};
  for (const slot of plan.folders) {
    const value = (state.folders[slot.id] ?? "").trim();
    if (!value) continue;
    const changed = value !== initial.folders[slot.id];
    const grantWrite = slot.sharedDefault === true && state.folderWrite[slot.id] === true;
    if (changed || grantWrite || slot.userSelected) folders[slot.id] = value;
  }
  if (Object.keys(folders).length > 0) options.folders = folders;

  const environment: Record<string, string> = {};
  for (const env of plan.environment) {
    const value = state.environment[env.name] ?? "";
    if (value && (value !== initial.environment[env.name] || env.origin === "user")) environment[env.name] = value;
  }
  if (Object.keys(environment).length > 0) options.environment = environment;

  const dependencies: Record<string, string> = {};
  for (const dep of plan.dependencies) {
    const value = state.dependencies[dep.dependency] ?? "";
    if (value && value !== initial.dependencies[dep.dependency]) dependencies[dep.dependency] = value;
  }
  if (Object.keys(dependencies).length > 0) options.dependencies = dependencies;

  return Object.keys(options).length > 0 ? options : undefined;
}
