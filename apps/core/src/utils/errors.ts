/**
 * Shared error formatting utilities.
 * Use these instead of inline `err instanceof Error ? err.message : String(err)`.
 */

/** Extract a human-readable message from any thrown value. */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

/** Format error with optional context prefix. */
export function formatErrorWithContext(context: string, err: unknown): string {
  return `${context}: ${formatError(err)}`;
}
