"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  AlertCircleIcon,
  HugeiconsIcon,
  TelegramIcon,
  DiscordIcon,
} from "@/components/icons";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow, SecretRow, settingsFetcher, settingsRequest } from "@/components/settings/settings-primitives";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Banner, BannerIcon, BannerTitle, BannerAction } from "@/components/kibo-ui/banner";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import { LevelPicker } from "@/components/settings/sections/notifications";
import { ChatBotSenders } from "@/components/settings/sections/chat-bot-senders";

function parseLevels(raw: string): string[] {
  // "none" is how an empty list is stored.
  return raw === "none" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Main integrations section (chat bots only) ──────────────────────────────

export function IntegrationsSection() {
  const confirm = useConfirm();
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramTokenEditing, setTelegramTokenEditing] = useState(false);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramLevels, setTelegramLevels] = useState<string[]>(["warning", "critical"]);
  const { data: telegramStatus, mutate: mutateTelegramStatus } = useSWR<{ connected: boolean; username?: string }>(
    `${CORE_URL}/api/integrations/telegram/status`,
    (url: string) => fetch(url).then(r => r.json()),
    { refreshInterval: 30000, revalidateOnFocus: false },
  );

  const [discordToken, setDiscordToken] = useState("");
  const [discordTokenEditing, setDiscordTokenEditing] = useState(false);
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordLevels, setDiscordLevels] = useState<string[]>(["warning", "critical"]);
  const { data: discordStatus, mutate: mutateDiscordStatus } = useSWR<{ connected: boolean; username?: string }>(
    `${CORE_URL}/api/integrations/discord/status`,
    (url: string) => fetch(url).then(r => r.json()),
    { refreshInterval: 30000, revalidateOnFocus: false },
  );

  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    settingsFetcher<Record<string, string>>(`${CORE_URL}/api/settings`)
      .then((data) => {
        if (cancelled) return;
        setSettingsLoadFailed(false);
        if (data.telegram_bot_token) setTelegramToken(data.telegram_bot_token);
        if (data.discord_bot_token) setDiscordToken(data.discord_bot_token);
        if (data.telegram_notification_levels) {
          setTelegramLevels(parseLevels(data.telegram_notification_levels));
        }
        if (data.discord_notification_levels) {
          setDiscordLevels(parseLevels(data.discord_notification_levels));
        }
      })
      .catch(() => {
        if (!cancelled) setSettingsLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const saveNotificationLevels = useCallback(async (platform: "telegram" | "discord", levels: string[]) => {
    const key = `${platform}_notification_levels`;
    const value = levels.join(",");
    try {
      // An empty list is stored as "none": the settings API skips empty values.
      await settingsRequest(`${CORE_URL}/api/settings`, { method: "POST", body: { [key]: value || "none" } }, "Couldn't save the notification levels. Try again.");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the notification levels. Try again.");
      return false;
    }
  }, []);

  // Never optimistic: the picker shows the new levels only once they're saved.
  const [levelsSaving, setLevelsSaving] = useState<"telegram" | "discord" | null>(null);
  const changeLevels = useCallback(async (platform: "telegram" | "discord", levels: string[]) => {
    setLevelsSaving(platform);
    const ok = await saveNotificationLevels(platform, levels);
    setLevelsSaving(null);
    if (!ok) return;
    if (platform === "telegram") setTelegramLevels(levels);
    else setDiscordLevels(levels);
  }, [saveNotificationLevels]);

  const handleTelegramLevels = useCallback((levels: string[]) => {
    void changeLevels("telegram", levels);
  }, [changeLevels]);

  const handleDiscordLevels = useCallback((levels: string[]) => {
    void changeLevels("discord", levels);
  }, [changeLevels]);

  return (
    <div className="grid gap-8">
      <p className="text-sm text-muted-foreground">
        Talk to Talome from your phone or desktop — no dashboard needed.
      </p>

      {settingsLoadFailed ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.5} className="shrink-0 text-status-critical" aria-hidden="true" />
          Couldn&apos;t load the saved bot settings, so what&apos;s shown may not be what Talome uses.
          <button
            type="button"
            className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setLoadAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}

      {/* Telegram */}
      <div className="grid gap-2">
        {telegramToken && !telegramStatus?.connected && (
          <Banner className="rounded-lg bg-status-warning/10 text-status-warning" inset>
            <BannerIcon icon={AlertCircleIcon} className="border-status-warning/20 bg-status-warning/10 text-status-warning" />
            <BannerTitle className="text-sm">Telegram bot is disconnected</BannerTitle>
            <BannerAction
              className="text-xs bg-status-warning/10 hover:bg-status-warning/20 text-status-warning border-status-warning/30"
              onClick={async () => {
                const res = await fetch(`${CORE_URL}/api/integrations/telegram/restart`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({}),
                });
                const d = await res.json() as { ok?: boolean; username?: string; error?: string };
                if (d.ok) { toast.success(`Connected as @${d.username}`); mutateTelegramStatus(); }
                else toast.error(d.error ?? "Failed to reconnect");
              }}>
              Reconnect
            </BannerAction>
          </Banner>
        )}
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <HugeiconsIcon icon={TelegramIcon} size={14} className="text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Telegram</p>
          </SettingsRow>
          <SecretRow
            label="Bot Token"
            hint="Create a bot with @BotFather, then paste the token here"
            id="telegram-token"
            placeholder="123456:ABC-DEF..."
            storedValue={telegramToken}
            isEditing={telegramTokenEditing}
            onEdit={() => setTelegramTokenEditing(true)}
            onChange={setTelegramToken}
          />
          <SettingsRow>
            <span className="text-sm flex-1 text-muted-foreground">Status</span>
            {telegramStatus?.connected ? (
              <span className="text-xs text-status-healthy font-medium">
                Connected as @{telegramStatus.username}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Not connected</span>
            )}
          </SettingsRow>
          {telegramStatus?.connected && (
            <SettingsRow>
              <span className="text-sm flex-1 text-muted-foreground">Send alerts for</span>
              <LevelPicker value={telegramLevels} onChange={handleTelegramLevels} busy={levelsSaving === "telegram"} />
            </SettingsRow>
          )}
          <ChatBotSenders platform="telegram" />
          <SettingsRow className="bg-muted/30 justify-end gap-2 py-3">
            {telegramStatus?.connected && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-status-critical hover:text-status-critical"
                onClick={async () => {
                  const { confirmed } = await confirm({
                    tier: "soft",
                    title: "Disconnect the Telegram bot?",
                    consequence: "The bot stops answering messages until you connect it again.",
                    recovery: "The bot token and allowed senders are kept, so reconnecting takes one click.",
                    confirmLabel: "Disconnect",
                    busyLabel: "Disconnecting…",
                    run: () => settingsRequest(`${CORE_URL}/api/integrations/telegram/stop`, { method: "POST" }, "Couldn't disconnect the Telegram bot. Try again."),
                    receipt: "Disconnected the Telegram bot",
                  });
                  if (confirmed) mutateTelegramStatus();
                }}
              >
                Disconnect…
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs px-4"
              disabled={telegramSaving || (!telegramToken && !telegramStatus?.connected)}
              onClick={async () => {
                setTelegramSaving(true);
                try {
                  const res = await fetch(`${CORE_URL}/api/integrations/telegram/restart`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: telegramTokenEditing ? telegramToken : undefined }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    toast.success(`Connected as @${data.username}`);
                    setTelegramTokenEditing(false);
                    mutateTelegramStatus();
                  } else {
                    toast.error(data.error ?? "Failed to connect");
                  }
                } catch {
                  toast.error("Failed to connect");
                } finally {
                  setTelegramSaving(false);
                }
              }}
            >
              {telegramSaving ? "Connecting..." : telegramStatus?.connected ? "Reconnect" : "Connect"}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </div>

      {/* Discord */}
      <div className="grid gap-2">
        {discordToken && !discordStatus?.connected && (
          <Banner className="rounded-lg bg-status-warning/10 text-status-warning" inset>
            <BannerIcon icon={AlertCircleIcon} className="border-status-warning/20 bg-status-warning/10 text-status-warning" />
            <BannerTitle className="text-sm">Discord bot is disconnected</BannerTitle>
            <BannerAction
              className="text-xs bg-status-warning/10 hover:bg-status-warning/20 text-status-warning border-status-warning/30"
              onClick={async () => {
                const res = await fetch(`${CORE_URL}/api/integrations/discord/restart`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({}),
                });
                const d = await res.json() as { ok?: boolean; username?: string; error?: string };
                if (d.ok) { toast.success(`Connected as ${d.username}`); mutateDiscordStatus(); }
                else toast.error(d.error ?? "Failed to reconnect");
              }}>
              Reconnect
            </BannerAction>
          </Banner>
        )}
        <SettingsGroup>
          <SettingsRow className="py-2.5">
            <HugeiconsIcon icon={DiscordIcon} size={14} className="text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Discord</p>
          </SettingsRow>
          <SecretRow
            label="Bot Token"
            hint="Create a bot at discord.com/developers, enable applications.commands scope"
            id="discord-token"
            placeholder="Enter Discord bot token"
            storedValue={discordToken}
            isEditing={discordTokenEditing}
            onEdit={() => setDiscordTokenEditing(true)}
            onChange={setDiscordToken}
          />
          <SettingsRow>
            <span className="text-sm flex-1 text-muted-foreground">Status</span>
            {discordStatus?.connected ? (
              <span className="text-xs text-status-healthy font-medium">
                Connected as {discordStatus.username}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Not connected</span>
            )}
          </SettingsRow>
          {discordStatus?.connected && (
            <SettingsRow>
              <span className="text-sm flex-1 text-muted-foreground">Send alerts for</span>
              <LevelPicker value={discordLevels} onChange={handleDiscordLevels} busy={levelsSaving === "discord"} />
            </SettingsRow>
          )}
          <ChatBotSenders platform="discord" />
          <SettingsRow className="bg-muted/30 justify-end gap-2 py-3">
            {discordStatus?.connected && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-status-critical hover:text-status-critical"
                onClick={async () => {
                  const { confirmed } = await confirm({
                    tier: "soft",
                    title: "Disconnect the Discord bot?",
                    consequence: "The bot stops answering messages until you connect it again.",
                    recovery: "The bot token and allowed senders are kept, so reconnecting takes one click.",
                    confirmLabel: "Disconnect",
                    busyLabel: "Disconnecting…",
                    run: () => settingsRequest(`${CORE_URL}/api/integrations/discord/stop`, { method: "POST" }, "Couldn't disconnect the Discord bot. Try again."),
                    receipt: "Disconnected the Discord bot",
                  });
                  if (confirmed) mutateDiscordStatus();
                }}
              >
                Disconnect…
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs px-4"
              disabled={discordSaving || (!discordToken && !discordStatus?.connected)}
              onClick={async () => {
                setDiscordSaving(true);
                try {
                  const res = await fetch(`${CORE_URL}/api/integrations/discord/restart`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: discordTokenEditing ? discordToken : undefined }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    toast.success(`Connected as ${data.username}`);
                    setDiscordTokenEditing(false);
                    mutateDiscordStatus();
                  } else {
                    toast.error(data.error ?? "Failed to connect");
                  }
                } catch {
                  toast.error("Failed to connect");
                } finally {
                  setDiscordSaving(false);
                }
              }}
            >
              {discordSaving ? "Connecting..." : discordStatus?.connected ? "Reconnect" : "Connect"}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      </div>

      <ConfigureWithAI prompt="I'd like to connect a chat bot" />
    </div>
  );
}
