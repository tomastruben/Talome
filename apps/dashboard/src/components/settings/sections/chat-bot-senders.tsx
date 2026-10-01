"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CORE_URL } from "@/lib/constants";
import { SettingsRow, relativeTime } from "@/components/settings/settings-primitives";

type Platform = "telegram" | "discord";

interface Sender {
  platform: Platform;
  userId: string;
  status: "allowed" | "rejected";
  displayName: string | null;
  rejectedCount: number;
  updatedAt: string;
}

const SENDER_ID = /^[0-9]{1,32}$/;

const COPY: Record<Platform, { idLabel: string; placeholder: string }> = {
  telegram: { idLabel: "Telegram user id", placeholder: "e.g. 123456789" },
  discord: { idLabel: "Discord user id", placeholder: "e.g. 312345678901234567" },
};

function senderLabel(s: Sender): string {
  return s.displayName ? `${s.displayName} · ${s.userId}` : s.userId;
}

/**
 * Who a chat bot answers. The bot acts with owner-level access, so it only
 * answers allowed senders; anyone else is told their user id and shows up
 * under "Blocked" here (and in a notification) for one-click allow.
 * Rendered as rows inside the platform's SettingsGroup.
 */
export function ChatBotSenders({ platform }: { platform: Platform }) {
  const url = `${CORE_URL}/api/integrations/messaging/senders?platform=${platform}`;
  const { data, mutate } = useSWR<{ senders: Sender[] }>(
    url,
    (u: string) => fetch(u).then((r) => (r.ok ? r.json() : { senders: [] })),
    { refreshInterval: 30000, revalidateOnFocus: false },
  );
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);

  const senders = data?.senders ?? [];
  const allowed = senders.filter((s) => s.status === "allowed");
  const blocked = senders.filter((s) => s.status === "rejected").slice(0, 5);

  async function allow(userId: string, displayName?: string | null) {
    setBusy(true);
    try {
      const res = await fetch(`${CORE_URL}/api/integrations/messaging/senders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, userId, ...(displayName ? { displayName } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? "Could not allow this sender");
        return;
      }
      toast.success(`${userId} can now use the bot`);
      setNewId("");
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setBusy(true);
    try {
      const res = await fetch(`${CORE_URL}/api/integrations/messaging/senders/${platform}/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      if (!res.ok) toast.error("Could not remove this sender");
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  const trimmed = newId.trim();

  return (
    <>
      <SettingsRow className="flex-wrap @lg:flex-nowrap gap-y-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Allowed users</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The bot can manage your server, so it only answers these people. Anyone else is told their user id and you get a notification.
          </p>
        </div>
        <div className="flex shrink-0 w-full @lg:w-72 gap-2">
          <Input
            aria-label={COPY[platform].idLabel}
            placeholder={COPY[platform].placeholder}
            value={newId}
            inputMode="numeric"
            onChange={(e) => setNewId(e.target.value)}
            className="text-sm h-8"
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-xs"
            disabled={busy || !SENDER_ID.test(trimmed)}
            onClick={() => allow(trimmed)}
          >
            Allow
          </Button>
        </div>
      </SettingsRow>
      {allowed.length === 0 ? (
        <SettingsRow>
          <span className="text-xs text-muted-foreground">
            No one yet. Message the bot, then allow your user id from the notification or below.
          </span>
        </SettingsRow>
      ) : (
        allowed.map((s) => (
          <SettingsRow key={`allowed-${s.userId}`}>
            <span className="text-sm flex-1 min-w-0 truncate">{senderLabel(s)}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive/70 hover:text-destructive"
              disabled={busy}
              onClick={() => remove(s.userId)}
            >
              Remove
            </Button>
          </SettingsRow>
        ))
      )}
      {blocked.map((s) => (
        <SettingsRow key={`blocked-${s.userId}`}>
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate">{senderLabel(s)}</p>
            <p className="text-xs text-muted-foreground">
              Blocked {s.rejectedCount === 1 ? "once" : `${s.rejectedCount} times`} · {relativeTime(s.updatedAt)}
            </p>
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => remove(s.userId)}>
            Dismiss
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={busy} onClick={() => allow(s.userId, s.displayName)}>
            Allow
          </Button>
        </SettingsRow>
      ))}
    </>
  );
}
