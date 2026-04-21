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
import { SettingsGroup, SettingsRow, SecretRow } from "@/components/settings/settings-primitives";
import { Banner, BannerIcon, BannerTitle, BannerAction } from "@/components/kibo-ui/banner";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import { LevelPicker } from "@/components/settings/sections/notifications";

// ── Main integrations section (chat bots only) ──────────────────────────────

export function IntegrationsSection() {
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

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.telegram_bot_token) setTelegramToken(data.telegram_bot_token);
        if (data.discord_bot_token) setDiscordToken(data.discord_bot_token);
        if (data.telegram_notification_levels) {
          setTelegramLevels(data.telegram_notification_levels.split(",").map((s) => s.trim()).filter(Boolean));
        }
        if (data.discord_notification_levels) {
          setDiscordLevels(data.discord_notification_levels.split(",").map((s) => s.trim()).filter(Boolean));
        }
      })
      .catch(() => {});
  }, []);

  const saveNotificationLevels = useCallback(async (platform: "telegram" | "discord", levels: string[]) => {
    const key = `${platform}_notification_levels`;
    const value = levels.join(",");
    try {
      await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
    } catch {
      // best-effort
    }
  }, []);

  const handleTelegramLevels = useCallback((levels: string[]) => {
    setTelegramLevels(levels);
    saveNotificationLevels("telegram", levels);
  }, [saveNotificationLevels]);

  const handleDiscordLevels = useCallback((levels: string[]) => {
    setDiscordLevels(levels);
    saveNotificationLevels("discord", levels);
  }, [saveNotificationLevels]);

  return (
    <div className="grid gap-8">
      <p className="text-sm text-muted-foreground">
        Talk to Talome from your phone or desktop — no dashboard needed.
      </p>

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
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Telegram</p>
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
              <LevelPicker value={telegramLevels} onChange={handleTelegramLevels} />
            </SettingsRow>
          )}
          <SettingsRow className="bg-muted/30 justify-end gap-2 py-3">
            {telegramStatus?.connected && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive/70 hover:text-destructive"
                onClick={async () => {
                  await fetch(`${CORE_URL}/api/integrations/telegram/stop`, { method: "POST" });
                  mutateTelegramStatus();
                  toast.success("Telegram bot stopped");
                }}
              >
                Disconnect
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
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Discord</p>
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
              <LevelPicker value={discordLevels} onChange={handleDiscordLevels} />
            </SettingsRow>
          )}
          <SettingsRow className="bg-muted/30 justify-end gap-2 py-3">
            {discordStatus?.connected && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive/70 hover:text-destructive"
                onClick={async () => {
                  await fetch(`${CORE_URL}/api/integrations/discord/stop`, { method: "POST" });
                  mutateDiscordStatus();
                  toast.success("Discord bot stopped");
                }}
              >
                Disconnect
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
