/**
 * Database dump / load commands for application-consistent backups.
 *
 * Commands run inside the database container via `docker exec` using the
 * container's own environment for credentials (POSTGRES_USER,
 * MARIADB_ROOT_PASSWORD, ...). Nothing secret is ever placed on the host
 * command line; passwords reach the client tools through PGPASSWORD /
 * MYSQL_PWD environment variables inside the container.
 */

import { open, stat } from "node:fs/promises";
import type { DbEngine } from "./types.js";

/** `sh -c` script producing a logical dump on stdout. */
export function dumpCommand(engine: Exclude<DbEngine, "redis">): string[] {
  if (engine === "postgres") {
    return [
      "sh",
      "-c",
      'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; exec pg_dumpall --clean --if-exists -U "${POSTGRES_USER:-postgres}"',
    ];
  }
  // MariaDB / MySQL: dump every non-system database the credentials can see.
  return [
    "sh",
    "-c",
    [
      'ROOTPW="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"',
      'if [ -n "$ROOTPW" ]; then U=root; export MYSQL_PWD="$ROOTPW"; else U="${MARIADB_USER:-${MYSQL_USER:-root}}"; export MYSQL_PWD="${MARIADB_PASSWORD:-${MYSQL_PASSWORD:-}}"; fi',
      "C=mysql; command -v mariadb >/dev/null 2>&1 && C=mariadb",
      "D=mysqldump; command -v mariadb-dump >/dev/null 2>&1 && D=mariadb-dump",
      "DBS=$($C -u\"$U\" -N -B -e 'SHOW DATABASES' | grep -Ev '^(information_schema|performance_schema|mysql|sys)$' | tr '\\n' ' ')",
      'if [ -z "$DBS" ]; then echo "no databases to dump" >&2; exit 3; fi',
      'exec $D -u"$U" --single-transaction --quick --routines --events --triggers --add-drop-database --databases $DBS',
    ].join("; "),
  ];
}

/** Readiness probe over TCP (entrypoint init servers only listen on the socket). */
export function readinessCommand(engine: Exclude<DbEngine, "redis">): string[] {
  if (engine === "postgres") {
    return ["sh", "-c", 'pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}"'];
  }
  return [
    "sh",
    "-c",
    "A=mysqladmin; command -v mariadb-admin >/dev/null 2>&1 && A=mariadb-admin; $A --protocol=tcp -h127.0.0.1 ping",
  ];
}

/** Load a dump file (already copied into the container) back into the server. */
export function loadCommand(engine: Exclude<DbEngine, "redis">, pathInContainer: string): string[] {
  const quoted = `'${pathInContainer.replace(/'/g, "'\\''")}'`;
  if (engine === "postgres") {
    return [
      "sh",
      "-c",
      `export PGPASSWORD="\${POSTGRES_PASSWORD:-}"; psql -X -q -v ON_ERROR_STOP=0 -U "\${POSTGRES_USER:-postgres}" -d postgres -f ${quoted}`,
    ];
  }
  return [
    "sh",
    "-c",
    [
      'ROOTPW="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"',
      'if [ -n "$ROOTPW" ]; then U=root; export MYSQL_PWD="$ROOTPW"; else U="${MARIADB_USER:-${MYSQL_USER:-root}}"; export MYSQL_PWD="${MARIADB_PASSWORD:-${MYSQL_PASSWORD:-}}"; fi',
      "C=mysql; command -v mariadb >/dev/null 2>&1 && C=mariadb",
      `$C -u"$U" < ${quoted}`,
    ].join("; "),
  ];
}

/**
 * Errors that a dump load always produces and that do not affect the data:
 * pg_dumpall --clean tries to drop/re-create the role it is connected as.
 */
const BENIGN_LOAD_ERRORS: RegExp[] = [
  /current user cannot be dropped/i,
  /role "[^"]+" already exists/i,
  /database "(postgres|template[01])" already exists/i,
];

/** Error lines from a dump load that indicate the load did not fully apply. */
export function significantLoadErrors(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /ERROR/.test(l) && !BENIGN_LOAD_ERRORS.some((re) => re.test(l)));
}

const REDIS_AUTH = 'if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; fi';
export const REDIS_BGSAVE = ["sh", "-c", `${REDIS_AUTH}; redis-cli BGSAVE`];
export const REDIS_PERSISTENCE_INFO = ["sh", "-c", `${REDIS_AUTH}; redis-cli INFO persistence`];

export function parseRedisPersistence(info: string): { inProgress: boolean; lastStatusOk: boolean; lastSave: number } {
  const get = (key: string) => info.match(new RegExp(`^${key}:(\\S+)`, "m"))?.[1] ?? "";
  return {
    inProgress: get("rdb_bgsave_in_progress") === "1",
    lastStatusOk: get("rdb_last_bgsave_status") === "ok",
    lastSave: parseInt(get("rdb_last_save_time"), 10) || 0,
  };
}

// ── Dump validation ─────────────────────────────────────────────────────────

const HEAD_PATTERNS: Record<Exclude<DbEngine, "redis">, RegExp> = {
  postgres: /PostgreSQL database (cluster )?dump/,
  mysql: /(MySQL|MariaDB) dump|-- Server version|mysqldump|mariadb-dump/i,
};

const TAIL_PATTERNS: Record<Exclude<DbEngine, "redis">, RegExp> = {
  postgres: /PostgreSQL database (cluster )?dump complete/,
  mysql: /-- Dump completed/,
};

async function readEdges(path: string, bytes = 8192): Promise<{ head: string; tail: string; size: number }> {
  const st = await stat(path);
  const fh = await open(path, "r");
  try {
    const headBuf = Buffer.alloc(Math.min(bytes, st.size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const tailLen = Math.min(bytes, st.size);
    const tailBuf = Buffer.alloc(tailLen);
    await fh.read(tailBuf, 0, tailLen, Math.max(0, st.size - tailLen));
    return { head: headBuf.toString("utf-8"), tail: tailBuf.toString("utf-8"), size: st.size };
  } finally {
    await fh.close();
  }
}

/**
 * Check that a SQL dump is non-empty, starts with the tool's header and ends
 * with its completion marker (a truncated dump has no trailer).
 */
export async function validateSqlDump(path: string, engine: Exclude<DbEngine, "redis">): Promise<{ ok: boolean; detail: string }> {
  try {
    const { head, tail, size } = await readEdges(path);
    if (size === 0) return { ok: false, detail: "dump is empty" };
    if (!HEAD_PATTERNS[engine].test(head)) return { ok: false, detail: "dump header not recognised" };
    if (!TAIL_PATTERNS[engine].test(tail)) return { ok: false, detail: "dump is incomplete (no completion marker)" };
    return { ok: true, detail: `${size} bytes` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
