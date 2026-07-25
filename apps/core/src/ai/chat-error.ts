export type ChatErrorCode =
  | "insufficient_credits"
  | "rate_limited"
  | "authentication_failed"
  | "provider_not_configured"
  | "request_aborted"
  | "network_error"
  | "provider_error";

export interface ChatErrorEnvelope {
  kind: "talome-chat-error";
  version: 1;
  provider: string;
  code: ChatErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

function parseResponseBody(responseBody: unknown): Record<string, unknown> | undefined {
  if (typeof responseBody !== "string") return undefined;
  try {
    const parsed = JSON.parse(responseBody);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Convert provider SDK errors into a stable protocol error for the dashboard.
 * Provider identity is captured when the request starts, so changing the model
 * selector while a stream is active cannot mislabel the eventual failure.
 */
export function classifyChatError(error: unknown, provider: string): ChatErrorEnvelope {
  const e = asRecord(error) ?? {};
  const response = parseResponseBody(e.responseBody);
  const responseRecord = asRecord(e.response);
  const data = asRecord(e.data);
  const dataError = asRecord(data?.error);
  const responseError = asRecord(response?.error);

  const message =
    asString(dataError?.message) ??
    asString(responseError?.message) ??
    asString(e.message) ??
    "Chat request failed";
  const upstreamCode = (
    asString(dataError?.code) ??
    asString(responseError?.code) ??
    asString(dataError?.type) ??
    asString(responseError?.type) ??
    asString(e.code) ??
    ""
  ).toLowerCase();
  const statusCode =
    (typeof e.statusCode === "number" ? e.statusCode : undefined) ??
    (typeof e.status === "number" ? e.status : undefined) ??
    (typeof responseRecord?.status === "number" ? responseRecord.status : undefined);
  const searchable = `${upstreamCode} ${message}`.toLowerCase();

  let code: ChatErrorCode = "provider_error";
  let retryable = Boolean(statusCode && statusCode >= 500);

  if (
    searchable.includes("ai_provider_not_configured") ||
    searchable.includes("api_key_missing") ||
    searchable.includes("no api key configured")
  ) {
    code = "provider_not_configured";
  } else if (
    upstreamCode.includes("insufficient_quota") ||
    upstreamCode.includes("credit_balance_too_low") ||
    searchable.includes("credit balance is too low") ||
    searchable.includes("insufficient credits") ||
    searchable.includes("exceeded your current quota") ||
    searchable.includes("billing hard limit")
  ) {
    code = "insufficient_credits";
  } else if (
    statusCode === 401 ||
    upstreamCode.includes("invalid_api_key") ||
    upstreamCode.includes("authentication_error") ||
    searchable.includes("invalid x-api-key") ||
    searchable.includes("invalid api key") ||
    searchable.includes("authentication required")
  ) {
    code = "authentication_failed";
  } else if (
    statusCode === 429 ||
    upstreamCode.includes("rate_limit") ||
    searchable.includes("rate limit") ||
    searchable.includes("too many requests")
  ) {
    code = "rate_limited";
    retryable = true;
  } else if (
    upstreamCode === "aborterror" ||
    searchable.includes("request aborted") ||
    searchable.includes("operation was aborted")
  ) {
    code = "request_aborted";
    retryable = true;
  } else if (
    upstreamCode.includes("econn") ||
    upstreamCode.includes("etimedout") ||
    searchable.includes("network error") ||
    searchable.includes("fetch failed") ||
    searchable.includes("connection reset") ||
    searchable.includes("timed out")
  ) {
    code = "network_error";
    retryable = true;
  }

  return {
    kind: "talome-chat-error",
    version: 1,
    provider,
    code,
    message,
    retryable,
    ...(statusCode ? { statusCode } : {}),
  };
}

export function serializeChatError(error: unknown, provider: string): string {
  return JSON.stringify(classifyChatError(error, provider));
}
