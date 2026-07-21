"use client";

import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";

function AssistantDashboardLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const router = useRouter();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (!requestDesktopNavigation(href)) router.push(href);
  };

  return (
    <a
      href={href}
      className="underline underline-offset-2 hover:text-destructive/90"
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

function getErrorMessageForDisplay(error: Error): string {
  const e = error as unknown as Record<string, unknown>;
  const data = e?.data;
  if (data && typeof data === "object" && data !== null) {
    const errObj = (data as Record<string, unknown>)?.error;
    if (
      errObj &&
      typeof errObj === "object" &&
      typeof (errObj as Record<string, unknown>).message === "string"
    ) {
      return (errObj as Record<string, unknown>).message as string;
    }
  }

  const msg = e?.message ?? "";
  if (typeof msg === "string" && msg.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(msg) as { error?: { message?: string } };
      if (parsed?.error?.message) return parsed.error.message;
    } catch {
      // ignore malformed JSON and fall through to raw message
    }
  }

  return (typeof msg === "string" ? msg : String(msg)) || "Failed to get a response. Please try again.";
}

export function AssistantChatError({
  error,
  provider = "anthropic",
  onDismiss,
}: {
  error: Error;
  provider?: string;
  onDismiss: () => void;
}) {
  const displayMessage = getErrorMessageForDisplay(error);
  const providerLabel = provider === "openai"
    ? "OpenAI"
    : provider === "ollama"
      ? "Ollama"
      : provider === "anthropic"
        ? "Anthropic"
        : provider;
  const billingUrl = provider === "openai"
    ? "https://platform.openai.com/settings/organization/billing/overview"
    : provider === "anthropic"
      ? "https://console.anthropic.com/settings/billing"
      : null;

  const isApiKeyError =
    displayMessage.includes("API key") ||
    displayMessage.includes("API_KEY_MISSING");

  const isCreditError =
    displayMessage.includes("credit balance is too low") ||
    displayMessage.includes("CREDIT_BALANCE_TOO_LOW");

  const isBudgetError =
    displayMessage.includes("Daily AI budget") ||
    displayMessage.includes("DAILY_CAP_EXCEEDED");

  const title = isApiKeyError
    ? "No API key configured"
    : isCreditError
      ? `${providerLabel} credit balance too low`
      : isBudgetError
        ? "Daily AI budget reached"
        : "Something went wrong";

  const body = isApiKeyError ? (
    <>
      Add your {providerLabel} API key in{" "}
      <AssistantDashboardLink href="/dashboard/settings">
        Settings
      </AssistantDashboardLink>{" "}
      to start using the assistant.
    </>
  ) : isCreditError ? (
    <>
      Your {providerLabel} account has insufficient credits.{" "}
      {billingUrl ? (
        <>
          <a
            href={billingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-destructive/90"
          >
            Add credits
          </a>{" "}
          to continue using the assistant.
        </>
      ) : "Choose another configured model or update the provider in Settings."}
    </>
  ) : isBudgetError ? (
    <>
      You&apos;ve hit today&apos;s spending cap. Increase or disable it in{" "}
      <AssistantDashboardLink href="/dashboard/settings">
        Settings &rarr; AI Cost
      </AssistantDashboardLink>
      .
    </>
  ) : (
    displayMessage
  );

  return (
    <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <HugeiconsIcon icon={AlertCircleIcon} size={16} className="mt-0.5 shrink-0 text-destructive/70" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-destructive/90">{title}</p>
          <p className="mt-1 text-destructive/60 text-sm">{body}</p>
        </div>
        <button onClick={onDismiss} className="shrink-0 text-destructive/40 hover:text-destructive/70 transition-colors text-xs">
          Dismiss
        </button>
      </div>
    </div>
  );
}
