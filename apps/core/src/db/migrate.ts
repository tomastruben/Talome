import { db } from "./index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

function recordMigration(version: number, description: string) {
  db.run(sql`INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (${version}, datetime('now'), ${description})`);
}

export function runMigrations() {
  // ── Schema version tracking ──────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, description TEXT)`);

  // ── Users table ────────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  )`);

  // Migrate single-password auth to first admin user
  try {
    const userCount = db.get(sql`SELECT COUNT(*) as count FROM users`) as { count: number } | undefined;
    if (userCount && userCount.count === 0) {
      const pwRow = db.get(sql`SELECT value FROM settings WHERE key = 'admin_password_hash'`) as { value: string } | undefined;
      if (pwRow?.value) {
        const id = randomUUID();
        const now = new Date().toISOString();
        db.run(sql`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (${id}, 'admin', ${pwRow.value}, 'admin', ${now})`);
        console.log("[migration] Migrated single-password to admin user");
      }
    }
  } catch {
    // Non-fatal — first boot or already migrated
  }

  // ── User permissions column ────────────────────────────────────────────────
  try {
    db.run(sql`ALTER TABLE users ADD COLUMN permissions TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Recovery code hash for password reset ──────────────────────────────────
  try {
    db.run(sql`ALTER TABLE users ADD COLUMN recovery_code_hash TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Metrics history ────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    cpu REAL NOT NULL,
    memory_used INTEGER NOT NULL,
    memory_total INTEGER NOT NULL,
    disk_used INTEGER NOT NULL,
    disk_total INTEGER NOT NULL,
    network_rx INTEGER NOT NULL,
    network_tx INTEGER NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp)`);

  // ── Proxy routes ──────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS proxy_routes (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    domain TEXT NOT NULL,
    upstream TEXT NOT NULL,
    tls_mode TEXT NOT NULL DEFAULT 'auto',
    enabled INTEGER NOT NULL DEFAULT 1,
    cert_status TEXT NOT NULL DEFAULT 'pending',
    cert_error TEXT,
    created_at TEXT NOT NULL
  )`);

  // ── Backups ───────────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    status TEXT NOT NULL,
    file_path TEXT,
    size_bytes INTEGER,
    cloud_target TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'manual'
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS backup_schedules (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    cron TEXT NOT NULL,
    cloud_target TEXT,
    retention_days INTEGER NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT NOT NULL
  )`);

  // ── App Update Policies ───────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS app_update_policies (
    app_id TEXT PRIMARY KEY,
    policy TEXT NOT NULL DEFAULT 'manual',
    cron TEXT,
    pre_backup INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`);

  // ── Notification Channels ─────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS notification_channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Conversation',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    tier TEXT NOT NULL,
    approved INTEGER NOT NULL DEFAULT 1,
    details TEXT NOT NULL DEFAULT ''
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS store_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    git_url TEXT,
    branch TEXT NOT NULL DEFAULT 'main',
    local_path TEXT,
    last_synced_at TEXT,
    app_count INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS app_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    store_source_id TEXT NOT NULL REFERENCES store_sources(id),
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'latest',
    tagline TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    release_notes TEXT,
    icon TEXT NOT NULL DEFAULT '📦',
    icon_url TEXT,
    cover_url TEXT,
    screenshots TEXT,
    install_notes TEXT,
    category TEXT NOT NULL DEFAULT 'other',
    author TEXT NOT NULL DEFAULT 'Unknown',
    website TEXT,
    repo TEXT,
    support TEXT,
    source TEXT NOT NULL,
    compose_path TEXT NOT NULL,
    image TEXT,
    ports TEXT NOT NULL DEFAULT '[]',
    volumes TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '[]',
    architectures TEXT,
    dependencies TEXT,
    default_username TEXT,
    default_password TEXT,
    web_port INTEGER,
    UNIQUE(store_source_id, app_id)
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS installed_apps (
    app_id TEXT PRIMARY KEY,
    store_source_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'installing',
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    env_config TEXT NOT NULL DEFAULT '{}',
    container_ids TEXT NOT NULL DEFAULT '[]',
    version TEXT NOT NULL DEFAULT 'latest'
  )`);

  // Additive column migrations — safe to re-run on existing databases
  try {
    db.run(sql`ALTER TABLE installed_apps ADD COLUMN override_compose_path TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE app_catalog ADD COLUMN cover_url TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE app_catalog ADD COLUMN install_notes TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE conversations ADD COLUMN platform TEXT NOT NULL DEFAULT 'dashboard'`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE conversations ADD COLUMN external_id TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE conversations ADD COLUMN user_id TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Optimistic locking version for chat session management
  try {
    db.run(sql`ALTER TABLE conversations ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // Column already exists — ignore
  }

  db.run(sql`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    read INTEGER NOT NULL DEFAULT 0,
    source_id TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    access_count INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS mcp_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger TEXT NOT NULL,
    conditions TEXT NOT NULL DEFAULT '[]',
    actions TEXT NOT NULL,
    last_run_at TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    triggered_at TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    actions_run INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT
  )`);

  try {
    db.run(sql`ALTER TABLE automation_runs ADD COLUMN result_summary TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Workflow v2 columns
  try {
    db.run(sql`ALTER TABLE automations ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE automations ADD COLUMN steps TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Fix automations.actions to allow NULL for v2 rows
  try {
    db.run(sql`ALTER TABLE automations ADD COLUMN _actions_migrated INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }

  db.run(sql`CREATE TABLE IF NOT EXISTS automation_step_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    automation_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    step_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    duration_ms INTEGER,
    success INTEGER NOT NULL DEFAULT 1,
    output TEXT,
    error TEXT,
    blocked INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS widget_manifests (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    data_source TEXT NOT NULL,
    size_presets TEXT NOT NULL DEFAULT '[{"cols":2,"rows":1}]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS evolution_log (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    task TEXT NOT NULL,
    scope TEXT NOT NULL,
    files_changed TEXT NOT NULL DEFAULT '[]',
    type_errors TEXT NOT NULL DEFAULT '',
    rolled_back INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS evolution_runs (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    pid INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    files_changed TEXT NOT NULL DEFAULT '[]',
    type_errors TEXT NOT NULL DEFAULT '',
    rolled_back INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`);

  try {
    db.run(sql`ALTER TABLE evolution_runs ADD COLUMN plan_result TEXT`);
  } catch {
    // Column already exists — ignore
  }

  db.run(sql`CREATE TABLE IF NOT EXISTS community_submissions (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review',
    bundle_json TEXT NOT NULL,
    checks_json TEXT NOT NULL DEFAULT '[]',
    review_notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT
  )`);

  // ── Evolution Suggestions ──────────────────────────────────────────────────

  db.run(sql`CREATE TABLE IF NOT EXISTS evolution_suggestions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    source_signals TEXT NOT NULL DEFAULT '[]',
    task_prompt TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'full',
    status TEXT NOT NULL DEFAULT 'pending',
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  try {
    db.run(sql`ALTER TABLE evolution_suggestions ADD COLUMN source TEXT NOT NULL DEFAULT 'scan'`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE evolution_suggestions ADD COLUMN screenshots TEXT NOT NULL DEFAULT '[]'`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE evolution_suggestions ADD COLUMN dismiss_reason TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE evolution_suggestions ADD COLUMN risk TEXT NOT NULL DEFAULT 'medium'`);
  } catch {
    // Column already exists — ignore
  }

  // ── evolution_runs additive columns
  try {
    db.run(sql`ALTER TABLE evolution_runs ADD COLUMN diff_output TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── evolution_runs display name for AI-generated session labels
  try {
    db.run(sql`ALTER TABLE evolution_runs ADD COLUMN display_name TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Install Errors ────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS install_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    service TEXT NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER,
    stderr TEXT NOT NULL DEFAULT '',
    parsed_issue TEXT,
    suggestion TEXT,
    variables_involved TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_install_errors_app_id ON install_errors(app_id)`);

  try {
    db.run(sql`ALTER TABLE install_errors ADD COLUMN variables_missing TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE install_errors ADD COLUMN stdout TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE install_errors ADD COLUMN compose_path TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE install_errors ADD COLUMN env_vars_at_time TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Container Events ────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS container_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id TEXT NOT NULL,
    container_name TEXT NOT NULL,
    new_state TEXT NOT NULL,
    reason TEXT,
    context TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_container_events_container_id ON container_events(container_id)`);

  try {
    db.run(sql`ALTER TABLE container_events ADD COLUMN previous_state TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Agent Loop tables ──────────────────────────────────────────────────────

  db.run(sql`CREATE TABLE IF NOT EXISTS system_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    triage_verdict TEXT,
    remediation_id TEXT,
    created_at TEXT NOT NULL
  )`);

  // ── system_events deduplication columns ──────────────────────────────────
  try {
    db.run(sql`ALTER TABLE system_events ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(sql`ALTER TABLE system_events ADD COLUMN last_seen TEXT`);
  } catch {
    // Column already exists — ignore
  }

  db.run(sql`CREATE TABLE IF NOT EXISTS ai_usage_log (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    context TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS remediation_log (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL,
    model TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'pending',
    verified_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content=memories, content_rowid=id)`);

  try {
    db.run(sql`CREATE TRIGGER IF NOT EXISTS memories_fts_insert
      AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END`);
  } catch {
    // Trigger already exists
  }

  try {
    db.run(sql`CREATE TRIGGER IF NOT EXISTS memories_fts_update
      AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END`);
  } catch {
    // Trigger already exists
  }

  try {
    db.run(sql`CREATE TRIGGER IF NOT EXISTS memories_fts_delete
      AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END`);
  } catch {
    // Trigger already exists
  }

  // ── Settings History ────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS settings_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    previous_value TEXT,
    new_value TEXT NOT NULL,
    changed_by TEXT NOT NULL DEFAULT 'ai',
    changed_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_settings_history_key ON settings_history(key)`);

  // ── App Groups ──────────────────────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS app_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    app_ids TEXT NOT NULL DEFAULT '[]',
    network_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  // ── Update Snapshots (for rollback) ────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS update_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    previous_version TEXT NOT NULL,
    previous_image TEXT,
    previous_compose TEXT,
    new_version TEXT,
    rolled_back INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_update_snapshots_app_id ON update_snapshots(app_id)`);

  // ── App catalog: hooks column ────────────────────────────────────────────
  try {
    db.run(sql`ALTER TABLE app_catalog ADD COLUMN hooks TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── App catalog: permissions column ──────────────────────────────────────
  try {
    db.run(sql`ALTER TABLE app_catalog ADD COLUMN permissions TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── App catalog: localized fields column ──────────────────────────────────
  try {
    db.run(sql`ALTER TABLE app_catalog ADD COLUMN localized_fields TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Image digest pinning for OTA updates ──────────────────────────────
  try {
    db.run(sql`ALTER TABLE installed_apps ADD COLUMN image_digest TEXT`);
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(sql`ALTER TABLE update_snapshots ADD COLUMN previous_digest TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Cache-aware AI usage tracking ────────────────────────────────────────
  try {
    db.run(sql`ALTER TABLE ai_usage_log ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(sql`ALTER TABLE ai_usage_log ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }

  // ── Performance indexes ────────────────────────────────────────────────
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at ON ai_usage_log(created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_log_context_created ON ai_usage_log(context, created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_remediation_log_created_at ON remediation_log(created_at)`);

  // ── High-traffic table indexes ────────────────────────────────────────
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id, updated_at DESC)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_conversations_platform ON conversations(platform)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_id ON automation_runs(automation_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_automation_step_runs_run_id ON automation_step_runs(run_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_catalog_app_store ON app_catalog(app_id, store_source_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_backups_app_id ON backups(app_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_system_events_type ON system_events(type)`);

  // ── Migrate mDNS settings to local_domains ─────────────────────────────
  try {
    const mdnsEnabled = db.get(sql`SELECT value FROM settings WHERE key = 'mdns_enabled'`) as { value: string } | undefined;
    if (mdnsEnabled?.value) {
      const existing = db.get(sql`SELECT value FROM settings WHERE key = 'local_domains_enabled'`) as { value: string } | undefined;
      if (!existing) {
        db.run(sql`INSERT INTO settings (key, value) VALUES ('local_domains_enabled', ${mdnsEnabled.value})`);
        console.log("[migration] Migrated mdns_enabled → local_domains_enabled");
      }
    }
    const mdnsDomain = db.get(sql`SELECT value FROM settings WHERE key = 'mdns_base_domain'`) as { value: string } | undefined;
    if (mdnsDomain?.value) {
      const existing = db.get(sql`SELECT value FROM settings WHERE key = 'local_domains_base'`) as { value: string } | undefined;
      if (!existing) {
        db.run(sql`INSERT INTO settings (key, value) VALUES ('local_domains_base', ${mdnsDomain.value})`);
        console.log("[migration] Migrated mdns_base_domain → local_domains_base");
      }
    }
  } catch {
    // Non-fatal — settings table might not exist yet on first boot
  }

  // ── Optimization jobs table ────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS optimization_jobs (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    target_path TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    source_codec TEXT NOT NULL DEFAULT '',
    source_audio_codec TEXT NOT NULL DEFAULT '',
    source_container TEXT NOT NULL DEFAULT '',
    progress REAL NOT NULL DEFAULT 0,
    duration_secs REAL NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    output_size INTEGER,
    keep_original INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    pid INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_optimization_jobs_status ON optimization_jobs(status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_optimization_jobs_source ON optimization_jobs(source_path)`);

  // ── Priority column for optimization jobs ──────────────────────────────────
  try {
    db.run(sql`ALTER TABLE optimization_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }

  // ── Retry tracking columns for optimization jobs ──────────────────────────
  try { db.run(sql`ALTER TABLE optimization_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(sql`ALTER TABLE optimization_jobs ADD COLUMN retry_strategy TEXT`); } catch {}
  try { db.run(sql`ALTER TABLE optimization_jobs ADD COLUMN last_command TEXT`); } catch {}

  // ── Library scan results (persistent optimization analysis cache) ────────
  db.run(sql`CREATE TABLE IF NOT EXISTS library_scan_results (
    file_path TEXT PRIMARY KEY,
    video_codec TEXT NOT NULL DEFAULT '',
    audio_codec TEXT NOT NULL DEFAULT '',
    container TEXT NOT NULL DEFAULT '',
    needs_optimization INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    can_transmux INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0,
    last_probed TEXT NOT NULL,
    directory TEXT NOT NULL DEFAULT ''
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_scan_results_directory ON library_scan_results(directory)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_scan_results_needs_opt ON library_scan_results(needs_optimization)`);

  // ── Supervisor events table ──────────────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS supervisor_events (
    id TEXT PRIMARY KEY,
    process TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    exit_code INTEGER,
    signal TEXT,
    crash_log TEXT,
    diagnosis TEXT,
    action_taken TEXT,
    revert_target TEXT,
    cost_usd REAL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_supervisor_events_process ON supervisor_events(process, created_at)`);

  // ── Revoked Sessions (JWT blacklist) ─────────────────────────────────────
  db.run(sql`CREATE TABLE IF NOT EXISTS revoked_sessions (
    jti TEXT PRIMARY KEY,
    revoked_at TEXT NOT NULL
  )`);

  // ── Production performance indexes ───────────────────────────────────────
  // Automations: cron scheduler filters by enabled
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations(enabled)`);
  // Installed apps: lifecycle checks filter by status
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_installed_apps_status ON installed_apps(status)`);
  // Messages: sorted queries per conversation (supersedes idx_messages_conversation_id)
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at)`);
  // Notifications: unread + sorted queries (supersedes individual read and created_at indexes)
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_notifications_read_created ON notifications(read, created_at)`);

  // ── Additional performance indexes ─────────────────────────────────────
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_app_catalog_category ON app_catalog(category)`);

  // ── AI diagnosis column for optimization jobs ──────────────────────────
  try { db.run(sql`ALTER TABLE optimization_jobs ADD COLUMN ai_diagnosis TEXT`); } catch {}

  // ── User-defined display name for installed apps ──────────────────────
  try {
    db.run(sql`ALTER TABLE installed_apps ADD COLUMN display_name TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // ── Setup loop tables ──────────────────────────────────────────────────
  db.run(sql`
    CREATE TABLE IF NOT EXISTS setup_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      trigger TEXT NOT NULL,
      health_score_before REAL,
      health_score_after REAL,
      apps_targeted TEXT NOT NULL DEFAULT '[]',
      attempts_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS setup_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES setup_runs(id),
      app_id TEXT NOT NULL,
      action TEXT NOT NULL,
      approach TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      settings_changed TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_setup_attempts_run_id ON setup_attempts(run_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_setup_runs_status ON setup_runs(status)`);

  // ── Record schema versions ─────────────────────────────────────────────
  recordMigration(1, "Initial schema: users, conversations, messages, settings, audit_log");
  recordMigration(2, "App store: store_sources, app_catalog, installed_apps");
  recordMigration(3, "Notifications, memories, mcp_tokens");
  recordMigration(4, "Automations: automations, automation_runs, automation_step_runs, widget_manifests");
  recordMigration(5, "Evolution: evolution_log, evolution_runs, evolution_suggestions");
  recordMigration(6, "Install errors, container events, system events, AI usage, remediation");
  recordMigration(7, "Metrics, proxy routes, backups, backup schedules, update policies");
  recordMigration(8, "Notification channels, push subscriptions, app groups, update snapshots");
  recordMigration(9, "Optimization jobs, library scan results, supervisor events");
  recordMigration(10, "Community submissions, settings history");
  recordMigration(11, "Performance indexes, FTS triggers, mDNS migration");
  recordMigration(12, "DB optimizations: schema_versions, N+1 fix, query limits, pragmas, new indexes");
  recordMigration(13, "Optimization jobs: ai_diagnosis column for AI-first error handling");
  recordMigration(14, "Installed apps: display_name column for user-defined app names");
  recordMigration(15, "Setup loop: setup_runs and setup_attempts for autonomous app configuration");

  console.log("Database migrations complete");
}
