"use client";

import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { HugeiconsIcon, AlertCircleIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { requestDesktopNavigation } from "@/lib/desktop-navigation";
import { parseAssistantError } from "@/lib/assistant-chat-error";

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
      className="rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={handleClick}
    >
      {children}
    </a>
  );
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
  const parsedError = parseAssistantError(error, provider);
  const displayMessage = parsedError.message;
  const errorProvider = parsedError.provider;
  const providerLabel = errorProvider === "openai"
    ? "OpenAI"
    : errorProvider === "ollama"
      ? "Ollama"
      : errorProvider === "anthropic"
        ? "Anthropic"
        : errorProvider;
  const billingUrl = errorProvider === "openai"
    ? "https://platform.openai.com/settings/organization/billing/overview"
    : errorProvider === "anthropic"
      ? "https://console.anthropic.com/settings/billing"
      : null;

  const isAuthenticationError = parsedError.code === "authentication_failed";
  const isConfigurationError = parsedError.code === "provider_not_configured" || parsedError.code === "api_key_missing";
  const isCreditError = parsedError.code === "insufficient_credits";
  const isBudgetError = parsedError.code === "daily_cap_exceeded";
  const isRateLimitError = parsedError.code === "rate_limited";

  const title = isConfigurationError
    ? "No API key configured"
    : isAuthenticationError
      ? `${providerLabel} authentication failed`
    : isCreditError
      ? `${providerLabel} credit balance too low`
      : isBudgetError
        ? "Daily AI budget reached"
        : isRateLimitError
          ? `${providerLabel} rate limit reached`
        : "Something went wrong";

  const body = isConfigurationError ? (
    <>
      Add your {providerLabel} API key in{" "}
      <AssistantDashboardLink href="/dashboard/settings">
        Settings
      </AssistantDashboardLink>{" "}
      to start using the assistant.
    </>
  ) : isAuthenticationError ? (
    <>
      {providerLabel} rejected the configured credentials. Check or replace the
      API key in{" "}
      <AssistantDashboardLink href="/dashboard/settings">
        Settings
      </AssistantDashboardLink>
      .
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
            className="rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  ) : isRateLimitError ? (
    <>The provider is temporarily busy. Wait a moment and try again.</>
  ) : (
    displayMessage
  );

  // The status tint recipe: a critical tint and icon, text in foreground, so
  // the message stays legible on window glass as well as on the page
  return (
    <div role="alert" className="rounded-xl border border-status-critical/30 bg-status-critical/12 px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <HugeiconsIcon icon={AlertCircleIcon} size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-status-critical" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-1 text-sm text-foreground wrap-break-word">{body}</p>
        </div>
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss} className="-my-0.5 shrink-0 text-muted-foreground hover:text-foreground">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
