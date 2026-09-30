/**
 * Talome AppSpec v1
 *
 * A deliberately small, declarative contract for rendering an application
 * inside Talome. AppSpecs contain no executable code. Data and actions are
 * resolved by the Core API so credentials never reach the browser.
 */

export const TALOME_APP_SPEC_VERSION = 1 as const;

export const TALOME_COMPONENT_IDS = [
  "stat",
  "list",
  "table",
  "progress",
  "time-series",
  "budget-overview",
  "comparison-bars",
  "activity-list",
  "markdown",
  "actions",
] as const;

export type TalomeComponentId = (typeof TALOME_COMPONENT_IDS)[number];
export type TalomeValueFormat =
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "bytes"
  | "date"
  | "relative-time";

export type TalomeHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TalomeAssistantSuggestion {
  label: string;
  prompt: string;
}

export interface TalomeAssistantSpec {
  /** Stable context injected into assistant prompts opened from this app. */
  context: string;
  suggestions: TalomeAssistantSuggestion[];
  /** Action IDs the assistant is explicitly allowed to discover and run. */
  exposedActions: string[];
}

export interface TalomeStaticDataSource {
  id: string;
  kind: "static";
  value: unknown;
}

export interface TalomeApiDataSource {
  id: string;
  kind: "talome-api";
  /** A same-server /api path. Core validates and proxies this path. */
  path: string;
  refreshMs?: number;
}

export interface TalomeAppApiDataSource {
  id: string;
  kind: "app-api";
  /** Installed app ID whose connection and credentials Core resolves. */
  appId: string;
  path: string;
  refreshMs?: number;
}

export type TalomeDataSource =
  | TalomeStaticDataSource
  | TalomeApiDataSource
  | TalomeAppApiDataSource;

export interface TalomeActionInput {
  id: string;
  label: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  description?: string;
}

export interface TalomeAssistantAction {
  id: string;
  label: string;
  description: string;
  kind: "assistant";
  prompt: string;
  input?: TalomeActionInput[];
}

interface TalomeApiActionBase {
  id: string;
  label: string;
  description: string;
  method: Exclude<TalomeHttpMethod, "GET"> | "GET";
  path: string;
  /** JSON-safe template. `{{field}}` values are replaced with validated input. */
  bodyTemplate?: unknown;
  input?: TalomeActionInput[];
  confirmation?: string;
  destructive?: boolean;
}

export interface TalomeTalomeApiAction extends TalomeApiActionBase {
  kind: "talome-api";
}

export interface TalomeExternalAppAction extends TalomeApiActionBase {
  kind: "app-api";
  appId: string;
}

export type TalomeApiAction = TalomeTalomeApiAction | TalomeExternalAppAction;

export type TalomeAppAction = TalomeAssistantAction | TalomeApiAction;

interface TalomeBlockBase {
  id: string;
  title: string;
  description?: string;
  /** Stable HugeIcons key resolved by Talome's native renderer. */
  icon?: string;
  /** Grid width from 1–4 columns. */
  span?: 1 | 2 | 3 | 4;
}

export interface TalomeStatBlock extends TalomeBlockBase {
  component: "stat";
  dataSource: string;
  valuePath: string;
  format?: TalomeValueFormat;
  currency?: string;
  detailPath?: string;
  emphasis?: "hero" | "supporting";
  progressValuePath?: string;
  progressMaxPath?: string;
  progressDetailPath?: string;
}

export interface TalomeListBlock extends TalomeBlockBase {
  component: "list";
  dataSource: string;
  itemsPath?: string;
  titlePath: string;
  descriptionPath?: string;
  metaPath?: string;
  statusPath?: string;
  limit?: number;
}

export interface TalomeTableColumn {
  id: string;
  label: string;
  path: string;
  format?: TalomeValueFormat;
  currency?: string;
}

export interface TalomeTableBlock extends TalomeBlockBase {
  component: "table";
  dataSource: string;
  rowsPath?: string;
  columns: TalomeTableColumn[];
  limit?: number;
}

export interface TalomeProgressBlock extends TalomeBlockBase {
  component: "progress";
  dataSource: string;
  valuePath: string;
  maxPath?: string;
  max?: number;
  valueFormat?: TalomeValueFormat;
  currency?: string;
}

export interface TalomeTimeSeries {
  /** Unique contract key; the renderer generates its own safe internal chart keys. */
  id: string;
  label: string;
  valuePath: string;
}

export interface TalomeTimeSeriesBlock extends TalomeBlockBase {
  component: "time-series";
  dataSource: string;
  rowsPath?: string;
  xPath: string;
  series: TalomeTimeSeries[];
  /** Bar compares ordered categories; line/area show ordered observations. */
  variant?: "line" | "area" | "bar";
  xLabel?: string;
  valueLabel?: string;
  /** Optional display suffix for custom numeric units, e.g. ms; does not convert data. */
  unit?: string;
  /** For charts, percent values are fractions: 0.01 = 1%, 1 = 100%. */
  valueFormat?: TalomeValueFormat;
  currency?: string;
  limit?: number;
}

/**
 * A finance workspace assembled from Talome's shared chart, category, activity,
 * and assistant components. The data source remains app-owned and declarative;
 * Talome supplies the consistent desktop and compact-window presentation.
 */
export interface TalomeBudgetOverviewBlock extends TalomeBlockBase {
  component: "budget-overview";
  dataSource: string;
  currency?: string;
  reviewActionId?: string;
}

export interface TalomeComparisonBarsBlock extends TalomeBlockBase {
  component: "comparison-bars";
  dataSource: string;
  rowsPath?: string;
  labelPath: string;
  plannedPath: string;
  actualPath: string;
  remainingPath?: string;
  statusPath?: string;
  plannedTotalPath?: string;
  actualTotalPath?: string;
  remainingTotalPath?: string;
  currency?: string;
  limit?: number;
  actionId?: string;
  compact?: boolean;
}

export interface TalomeActivityFilter {
  label: string;
  value: string;
}

export interface TalomeActivityRowAction {
  actionId: string;
  inputId: string;
  valuePath: string;
}

export interface TalomeActivityListBlock extends TalomeBlockBase {
  component: "activity-list";
  dataSource: string;
  rowsPath?: string;
  datePath: string;
  titlePath: string;
  descriptionPath?: string;
  kindPath?: string;
  valuePath: string;
  valueFormat?: TalomeValueFormat;
  currency?: string;
  searchPaths?: string[];
  filterPath?: string;
  filters?: TalomeActivityFilter[];
  rowAction?: TalomeActivityRowAction;
  footerActionId?: string;
  starterFlagPath?: string;
  limit?: number;
  compact?: boolean;
}

export interface TalomeMarkdownBlock extends TalomeBlockBase {
  component: "markdown";
  content?: string;
  dataSource?: string;
  contentPath?: string;
}

export interface TalomeActionsBlock extends TalomeBlockBase {
  component: "actions";
  actionIds: string[];
}

export type TalomeAppBlock =
  | TalomeStatBlock
  | TalomeListBlock
  | TalomeTableBlock
  | TalomeProgressBlock
  | TalomeTimeSeriesBlock
  | TalomeBudgetOverviewBlock
  | TalomeComparisonBarsBlock
  | TalomeActivityListBlock
  | TalomeMarkdownBlock
  | TalomeActionsBlock;

export interface TalomeAppSurface {
  id: string;
  title: string;
  description?: string;
  layout: "dashboard" | "list" | "detail";
  /** Contextual primary action shown in the app header for this surface. */
  primaryActionId?: string;
  blocks: TalomeAppBlock[];
}

export interface TalomeAppSpec {
  schemaVersion: typeof TALOME_APP_SPEC_VERSION;
  revision: number;
  appId: string;
  name: string;
  description: string;
  icon?: string;
  assistant: TalomeAssistantSpec;
  dataSources: TalomeDataSource[];
  actions: TalomeAppAction[];
  surfaces: TalomeAppSurface[];
}

export type TalomeAppSpecStatus = "draft" | "approved" | "disabled";

export interface TalomeNativeSurfaceDescriptor {
  schemaVersion: typeof TALOME_APP_SPEC_VERSION;
  revision: number;
  status: TalomeAppSpecStatus;
}
