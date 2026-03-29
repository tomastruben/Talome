import { db, schema } from "./index.js";

type AuditTier = "read" | "modify" | "destructive";

export function writeAuditEntry(
  action: string,
  tier: AuditTier,
  details = "",
  approved = true,
) {
  db.insert(schema.auditLog)
    .values({ action, tier, details, approved })
    .run();
}
