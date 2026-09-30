/**
 * Recovery codes (v2) are 24 Crockford base32 characters shown as six groups
 * of four. Core normalises input the same way (apps/core/src/routes/auth.ts),
 * so a code typed in lower case, without hyphens, or with O/I/L look-alikes
 * still works.
 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** The code split into its display groups ("7K3M-Q9TD-…" → ["7K3M", "Q9TD", …]). */
export function recoveryCodeGroups(code: string): string[] {
  const grouped = code.trim().split("-").filter(Boolean);
  if (grouped.length > 1) return grouped;
  // Legacy codes (issued before v2) have no groups: show them whole.
  return [code.trim()];
}

/** The last display group, which the person types back to confirm they saved the code. */
export function lastRecoveryGroup(code: string): string {
  const groups = recoveryCodeGroups(code);
  return groups[groups.length - 1] ?? "";
}

/** Whether typed input matches the last group (case, spaces and look-alikes ignored). */
export function matchesLastGroup(code: string, typed: string): boolean {
  const expected = normalizeRecoveryCode(lastRecoveryGroup(code));
  return expected.length > 0 && normalizeRecoveryCode(typed) === expected;
}

/** Plain-text file contents for Download and Print. */
export function recoveryCodeDocument(code: string, username?: string, serverName?: string): string {
  const lines = [
    "Talome recovery code",
    "",
    ...(username ? [`Account: ${username}`] : []),
    ...(serverName ? [`Server: ${serverName}`] : []),
    `Code: ${code}`,
    "",
    "Use this code on the sign-in screen (Forgot password?) to set a new password.",
    "It works once. After you use it, Talome gives you a new one.",
    "Keep it somewhere safe and private, like a password manager.",
  ];
  return `${lines.join("\n")}\n`;
}
