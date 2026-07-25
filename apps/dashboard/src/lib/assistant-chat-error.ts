export interface ParsedAssistantError {
  provider: string;
  code: string;
  message: string;
  retryable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseEnvelope(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value) ?? parseJson(value);
  if (!record) return undefined;

  if (record.kind === "talome-chat-error") return record;

  const nestedError = asRecord(record.error);
  if (nestedError?.kind === "talome-chat-error") return nestedError;
  if (typeof record.error === "string") {
    const nestedJson = parseJson(record.error);
    if (nestedJson?.kind === "talome-chat-error") return nestedJson;
  }

  return record;
}

export function parseAssistantError(error: Error, fallbackProvider: string): ParsedAssistantError {
  const e = error as unknown as Record<string, unknown>;
  const root = parseEnvelope(e.data) ?? parseEnvelope(e.message) ?? {};
  const nested = asRecord(root.error);

  const message =
    (typeof root.message === "string" ? root.message : undefined) ??
    (typeof root.error === "string" ? root.error : undefined) ??
    (typeof nested?.message === "string" ? nested.message : undefined) ??
    (typeof e.message === "string" ? e.message : undefined) ??
    "Failed to get a response. Please try again.";
  const provider = typeof root.provider === "string" ? root.provider : fallbackProvider;
  let code = typeof root.code === "string" ? root.code.toLowerCase() : "";
  const searchable = `${code} ${message}`.toLowerCase();

  // Backward compatibility for errors emitted before the structured protocol.
  if (!code) {
    if (
      searchable.includes("credit balance is too low") ||
      searchable.includes("insufficient credits") ||
      searchable.includes("insufficient_quota") ||
      searchable.includes("credit_balance_too_low")
    ) code = "insufficient_credits";
    else if (searchable.includes("rate limit") || searchable.includes("too many requests")) code = "rate_limited";
    else if (searchable.includes("api key") || searchable.includes("authentication")) code = "authentication_failed";
    else if (searchable.includes("daily ai budget") || searchable.includes("daily_cap_exceeded")) code = "daily_cap_exceeded";
    else code = "provider_error";
  }

  return {
    provider,
    code,
    message,
    retryable: typeof root.retryable === "boolean"
      ? root.retryable
      : code === "rate_limited" || code === "network_error" || code === "request_aborted",
  };
}
