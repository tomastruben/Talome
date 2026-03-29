import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  /** JSON-serialized UserPermissions — only enforced for member role */
  permissions: text("permissions"),
  /** Bcrypt hash of the recovery code — used for password reset without email */
  recoveryCodeHash: text("recovery_code_hash"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastLoginAt: text("last_login_at"),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("New Conversation"),
  platform: text("platform").notNull().default("dashboard"),
  externalId: text("external_id"),
  userId: text("user_id"),
  /** Optimistic locking version — incremented on every update */
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
  action: text("action").notNull(),
  tier: text("tier", { enum: ["read", "modify", "destructive"] }).notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(true),
  details: text("details").notNull().default(""),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const settingsHistory = sqliteTable("settings_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull(),
  previousValue: text("previous_value"),
  newValue: text("new_value").notNull(),
  changedBy: text("changed_by").notNull().default("ai"),
  changedAt: text("changed_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const storeSources = sqliteTable("store_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  gitUrl: text("git_url"),
  branch: text("branch").notNull().default("main"),
  localPath: text("local_path"),
  lastSyncedAt: text("last_synced_at"),
  appCount: integer("app_count").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const appCatalog = sqliteTable("app_catalog", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: text("app_id").notNull(),
  storeSourceId: text("store_source_id").notNull().references(() => storeSources.id),
  name: text("name").notNull(),
  version: text("version").notNull().default("latest"),
  tagline: text("tagline").notNull().default(""),
  description: text("description").notNull().default(""),
  releaseNotes: text("release_notes"),
  icon: text("icon").notNull().default("📦"),
  iconUrl: text("icon_url"),
  coverUrl: text("cover_url"),
  screenshots: text("screenshots"),
  installNotes: text("install_notes"),
  category: text("category").notNull().default("other"),
  author: text("author").notNull().default("Unknown"),
  website: text("website"),
  repo: text("repo"),
  support: text("support"),
  source: text("source").notNull(),
  composePath: text("compose_path").notNull(),
  image: text("image"),
  ports: text("ports").notNull().default("[]"),
  volumes: text("volumes").notNull().default("[]"),
  env: text("env").notNull().default("[]"),
  architectures: text("architectures"),
  dependencies: text("dependencies"),
  hooks: text("hooks"),
  permissions: text("permissions"),
  localizedFields: text("localized_fields"),
  defaultUsername: text("default_username"),
  defaultPassword: text("default_password"),
  webPort: integer("web_port"),
});

export const installedApps = sqliteTable("installed_apps", {
  appId: text("app_id").primaryKey(),
  storeSourceId: text("store_source_id").notNull(),
  status: text("status").notNull().default("installing"),
  installedAt: text("installed_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  envConfig: text("env_config").notNull().default("{}"),
  containerIds: text("container_ids").notNull().default("[]"),
  version: text("version").notNull().default("latest"),
  overrideComposePath: text("override_compose_path"),
  /** SHA256 image digest at install/update time — for reproducible deploys */
  imageDigest: text("image_digest"),
  /** User-defined display name override */
  displayName: text("display_name"),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type", { enum: ["info", "warning", "critical"] }).notNull().default("info"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  sourceId: text("source_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const mcpTokens = sqliteTable("mcp_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  lastUsedAt: text("last_used_at"),
});

export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type", { enum: ["preference", "fact", "context", "correction"] }).notNull(),
  content: text("content").notNull(),
  source: text("source"),
  confidence: real("confidence").notNull().default(1.0),
  accessCount: integer("access_count").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  trigger: text("trigger").notNull(),
  conditions: text("conditions").notNull().default("[]"),
  // v1 legacy flat actions array
  actions: text("actions").notNull().default("[]"),
  // v2 step-based workflow
  workflowVersion: integer("workflow_version").notNull().default(1),
  steps: text("steps"),
  lastRunAt: text("last_run_at"),
  runCount: integer("run_count").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
  triggeredAt: text("triggered_at").notNull().$defaultFn(() => new Date().toISOString()),
  success: integer("success", { mode: "boolean" }).notNull().default(true),
  error: text("error"),
  actionsRun: integer("actions_run").notNull().default(0),
  resultSummary: text("result_summary"),
});

export const automationStepRuns = sqliteTable("automation_step_runs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => automationRuns.id, { onDelete: "cascade" }),
  automationId: text("automation_id").notNull(),
  stepId: text("step_id").notNull(),
  stepType: text("step_type").notNull(),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  durationMs: integer("duration_ms"),
  success: integer("success", { mode: "boolean" }).notNull().default(true),
  output: text("output"),
  error: text("error"),
  blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
});

export const widgetManifests = sqliteTable("widget_manifests", {
  id: text("id").primaryKey(),
  version: integer("version").notNull().default(1),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  dataSource: text("data_source").notNull(),
  sizePresets: text("size_presets").notNull().default('[{"cols":2,"rows":1}]'),
  status: text("status", { enum: ["draft", "pending_review", "approved", "disabled"] })
    .notNull()
    .default("draft"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const evolutionLog = sqliteTable("evolution_log", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
  task: text("task").notNull(),
  scope: text("scope").notNull(),
  filesChanged: text("files_changed").notNull().default("[]"),
  typeErrors: text("type_errors").notNull().default(""),
  rolledBack: integer("rolled_back", { mode: "boolean" }).notNull().default(false),
  duration: integer("duration").notNull().default(0),
});

// ── Terminal Sessions (daemon persistence) ───────────────────────────────────
// Managed directly by the terminal daemon via raw SQL. Drizzle schema here
// is for documentation and potential enrichment queries from the main server.

export const terminalSessions = sqliteTable("terminal_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  displayName: text("display_name"),
  scrollBuffer: text("scroll_buffer").notNull().default(""),
  cols: integer("cols").notNull().default(80),
  rows: integer("rows").notNull().default(24),
  createdAt: integer("created_at").notNull(),
  lastActivityAt: integer("last_activity_at").notNull(),
});

export const evolutionRuns = sqliteTable("evolution_runs", {
  id: text("id").primaryKey(),
  task: text("task").notNull(),
  scope: text("scope").notNull(),
  // running | applied | failed | rolled_back | interrupted
  status: text("status").notNull().default("running"),
  pid: integer("pid"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
  filesChanged: text("files_changed").notNull().default("[]"),
  typeErrors: text("type_errors").notNull().default(""),
  rolledBack: integer("rolled_back", { mode: "boolean" }).notNull().default(false),
  duration: integer("duration").notNull().default(0),
  error: text("error"),
  planResult: text("plan_result"),
  diffOutput: text("diff_output"),
  displayName: text("display_name"),
});

// ── Evolution Suggestions ────────────────────────────────────────────────────

export const evolutionSuggestions = sqliteTable("evolution_suggestions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category", {
    enum: ["performance", "reliability", "ux", "feature", "maintenance"],
  }).notNull(),
  priority: text("priority", { enum: ["low", "medium", "high"] }).notNull(),
  sourceSignals: text("source_signals").notNull().default("[]"),
  taskPrompt: text("task_prompt").notNull(),
  scope: text("scope").notNull().default("full"),
  status: text("status", {
    enum: ["pending", "in_progress", "completed", "dismissed", "done"],
  }).notNull().default("pending"),
  risk: text("risk", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
  source: text("source", { enum: ["scan", "chat", "bug_hunt"] }).notNull().default("scan"),
  screenshots: text("screenshots").notNull().default("[]"),
  dismissReason: text("dismiss_reason"),
  runId: text("run_id"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Install Errors ───────────────────────────────────────────────────────────

export const installErrors = sqliteTable("install_errors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: text("app_id").notNull(),
  service: text("service").notNull(),
  command: text("command").notNull(),
  exitCode: integer("exit_code"),
  stderr: text("stderr").notNull().default(""),
  stdout: text("stdout").notNull().default(""),
  parsedIssue: text("parsed_issue"),
  suggestion: text("suggestion"),
  variablesInvolved: text("variables_involved").notNull().default("[]"),
  variablesMissing: text("variables_missing"),
  composePath: text("compose_path"),
  envVarsAtTime: text("env_vars_at_time").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Container Events ────────────────────────────────────────────────────────

export const containerEvents = sqliteTable("container_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  containerId: text("container_id").notNull(),
  containerName: text("container_name").notNull(),
  previousState: text("previous_state"),
  newState: text("new_state").notNull(),
  reason: text("reason"),
  context: text("context").notNull().default("{}"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Agent Loop tables ────────────────────────────────────────────────────────

export const systemEvents = sqliteTable("system_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  data: text("data").notNull().default("{}"),
  triageVerdict: text("triage_verdict"),
  remediationId: text("remediation_id"),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  lastSeen: text("last_seen"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const aiUsageLog = sqliteTable("ai_usage_log", {
  id: text("id").primaryKey(),
  model: text("model").notNull(),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  context: text("context").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const remediationLog = sqliteTable("remediation_log", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  action: text("action").notNull(),
  model: text("model").notNull(),
  confidence: real("confidence").notNull().default(0),
  outcome: text("outcome").notNull().default("pending"),
  verifiedAt: text("verified_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Metrics History ──────────────────────────────────────────────────────────

export const metrics = sqliteTable("metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
  cpu: real("cpu").notNull(),
  memoryUsed: integer("memory_used").notNull(),
  memoryTotal: integer("memory_total").notNull(),
  diskUsed: integer("disk_used").notNull(),
  diskTotal: integer("disk_total").notNull(),
  networkRx: integer("network_rx").notNull(),
  networkTx: integer("network_tx").notNull(),
});

// ── Proxy Routes ─────────────────────────────────────────────────────────────

export const proxyRoutes = sqliteTable("proxy_routes", {
  id: text("id").primaryKey(),
  appId: text("app_id"),
  domain: text("domain").notNull(),
  upstream: text("upstream").notNull(),
  tlsMode: text("tls_mode", { enum: ["auto", "selfsigned", "manual", "off"] }).notNull().default("auto"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  certStatus: text("cert_status", { enum: ["pending", "active", "error", "selfsigned"] }).notNull().default("pending"),
  certError: text("cert_error"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Backups ──────────────────────────────────────────────────────────────────

export const backups = sqliteTable("backups", {
  id: text("id").primaryKey(),
  appId: text("app_id"),
  status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull(),
  filePath: text("file_path"),
  sizeBytes: integer("size_bytes"),
  cloudTarget: text("cloud_target"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
  error: text("error"),
  triggeredBy: text("triggered_by", { enum: ["manual", "schedule"] }).notNull().default("manual"),
});

export const backupSchedules = sqliteTable("backup_schedules", {
  id: text("id").primaryKey(),
  appId: text("app_id"), // null = all apps
  cron: text("cron").notNull(),
  cloudTarget: text("cloud_target"),
  retentionDays: integer("retention_days").notNull().default(30),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── App Update Policies ─────────────────────────────────────────────────────

export const appUpdatePolicies = sqliteTable("app_update_policies", {
  appId: text("app_id").primaryKey(),
  policy: text("policy", { enum: ["auto", "manual", "schedule"] }).notNull().default("manual"),
  cron: text("cron"),
  preBackup: integer("pre_backup", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Notification Channels ───────────────────────────────────────────────────

export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["webhook", "ntfy", "webpush", "email"] }).notNull(),
  name: text("name").notNull(),
  config: text("config").notNull(), // JSON
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── App Groups ──────────────────────────────────────────────────────────────

export const appGroups = sqliteTable("app_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  appIds: text("app_ids").notNull().default("[]"),
  networkName: text("network_name"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Update Snapshots (for rollback) ─────────────────────────────────────────

export const updateSnapshots = sqliteTable("update_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: text("app_id").notNull(),
  previousVersion: text("previous_version").notNull(),
  previousImage: text("previous_image"),
  /** SHA256 digest of the image before update — used for digest-pinned rollback */
  previousDigest: text("previous_digest"),
  previousCompose: text("previous_compose"),
  newVersion: text("new_version"),
  rolledBack: integer("rolled_back", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Library Operations (file reorg audit/rollback log) ───────────────────────

export const libraryOperations = sqliteTable("library_operations", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull(),
  type: text("type", { enum: ["move", "rename", "delete"] }).notNull(),
  sourcePath: text("source_path").notNull(),
  targetPath: text("target_path"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  status: text("status", { enum: ["pending", "completed", "failed", "undone"] }).notNull().default("pending"),
  error: text("error"),
  executedAt: text("executed_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const optimizationJobs = sqliteTable("optimization_jobs", {
  id: text("id").primaryKey(),
  sourcePath: text("source_path").notNull(),
  targetPath: text("target_path"),
  status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).notNull().default("queued"),
  sourceCodec: text("source_codec").notNull().default(""),
  sourceAudioCodec: text("source_audio_codec").notNull().default(""),
  sourceContainer: text("source_container").notNull().default(""),
  progress: real("progress").notNull().default(0),
  durationSecs: real("duration_secs").notNull().default(0),
  fileSize: integer("file_size").notNull().default(0),
  outputSize: integer("output_size"),
  keepOriginal: integer("keep_original", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0),
  error: text("error"),
  pid: integer("pid"),
  retryCount: integer("retry_count").notNull().default(0),
  retryStrategy: text("retry_strategy"),
  lastCommand: text("last_command"),
  /** Structured AI diagnosis of the failure (separate from raw error string) */
  aiDiagnosis: text("ai_diagnosis"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

export const libraryScanResults = sqliteTable("library_scan_results", {
  filePath: text("file_path").primaryKey(),
  videoCodec: text("video_codec").notNull().default(""),
  audioCodec: text("audio_codec").notNull().default(""),
  container: text("container").notNull().default(""),
  needsOptimization: integer("needs_optimization", { mode: "boolean" }).notNull().default(false),
  reason: text("reason").notNull().default(""),
  canTransmux: integer("can_transmux", { mode: "boolean" }).notNull().default(false),
  fileSize: integer("file_size").notNull().default(0),
  fileMtime: integer("file_mtime").notNull().default(0),
  lastProbed: text("last_probed").notNull().$defaultFn(() => new Date().toISOString()),
  directory: text("directory").notNull().default(""),
});

// ── Supervisor Events ────────────────────────────────────────────────────────

export const supervisorEvents = sqliteTable("supervisor_events", {
  id: text("id").primaryKey(),
  process: text("process").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull().default("warning"),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  crashLog: text("crash_log"),
  diagnosis: text("diagnosis"),
  actionTaken: text("action_taken"),
  revertTarget: text("revert_target"),
  costUsd: real("cost_usd").default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const schemaVersions = sqliteTable("schema_versions", {
  version: integer().primaryKey(),
  appliedAt: text().notNull(),
  description: text(),
});

// ── Revoked Sessions (JWT blacklist) ─────────────────────────────────────────

export const revokedSessions = sqliteTable("revoked_sessions", {
  jti: text("jti").primaryKey(),
  revokedAt: text("revoked_at").notNull(),
});

export const communitySubmissions = sqliteTable("community_submissions", {
  id: text("id").primaryKey(),
  appId: text("app_id").notNull(),
  appName: text("app_name").notNull(),
  authorName: text("author_name").notNull(),
  authorEmail: text("author_email"),
  status: text("status", { enum: ["pending_review", "approved", "rejected"] })
    .notNull()
    .default("pending_review"),
  bundleJson: text("bundle_json").notNull(),
  checksJson: text("checks_json").notNull().default("[]"),
  reviewNotes: text("review_notes"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  publishedAt: text("published_at"),
});
