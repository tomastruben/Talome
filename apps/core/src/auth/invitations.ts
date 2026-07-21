import { createHash, randomBytes } from "node:crypto";

/** Raw invitation tokens are URL-safe capabilities and are never persisted. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
