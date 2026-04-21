"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";

// ── Notification level picker ────────────────────────────────────────────────

const LEVELS = ["warning", "critical"] as const;

export function LevelPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (levels: string[]) => void;
}) {
  const toggle = (level: string) => {
    if (value.includes(level)) {
      onChange(value.filter((l) => l !== level));
    } else {
      onChange([...value, level]);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {LEVELS.map((level) => {
        const active = value.includes(level);
        return (
          <button
            key={level}
            type="button"
            onClick={() => toggle(level)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              active
                ? level === "critical"
                  ? "bg-status-critical/15 text-status-critical border border-status-critical/30"
                  : "bg-status-warning/15 text-status-warning border border-status-warning/30"
                : "bg-muted/50 text-muted-foreground border border-transparent hover:bg-muted"
            }`}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}

// ── Alert thresholds ─────────────────────────────────────────────────────────

interface Thresholds {
  cpu: { warning: number; critical: number } | null;
  memory: { warning: number; critical: number } | null;
  disk: { warning: number; critical: number };
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function AlertThresholdsSection() {
  const { data: thresholds, mutate: mutateThresholds } = useSWR<Thresholds>(
    `${CORE_URL}/api/settings/alert-thresholds`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const [cpuWarn, setCpuWarn] = useState("");
  const [cpuCrit, setCpuCrit] = useState("");
  const [memWarn, setMemWarn] = useState("");
  const [memCrit, setMemCrit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (thresholds) {
      setCpuWarn(thresholds.cpu?.warning?.toString() ?? "");
      setCpuCrit(thresholds.cpu?.critical?.toString() ?? "");
      setMemWarn(thresholds.memory?.warning?.toString() ?? "");
      setMemCrit(thresholds.memory?.critical?.toString() ?? "");
    }
  }, [thresholds]);

  async function saveThresholds() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (cpuWarn && cpuCrit) body.cpu = { warning: Number(cpuWarn), critical: Number(cpuCrit) };
      if (memWarn && memCrit) body.memory = { warning: Number(memWarn), critical: Number(memCrit) };

      const res = await fetch(`${CORE_URL}/api/settings/alert-thresholds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.error(data.error ?? "Failed to save thresholds");
        return;
      }
      toast.success("Alert thresholds saved");
      void mutateThresholds();
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function clearThresholds() {
    try {
      await fetch(`${CORE_URL}/api/settings/alert-thresholds`, { method: "DELETE" });
      setCpuWarn("");
      setCpuCrit("");
      setMemWarn("");
      setMemCrit("");
      toast.success("Alert thresholds cleared");
      void mutateThresholds();
    } catch {
      toast.error("Network error");
    }
  }

  const thresholdInput = "h-8 w-16 rounded-md border border-border bg-input px-2 text-sm text-center tabular-nums";

  return (
    <SettingsGroup>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Alert thresholds</span>
        <div className="flex items-center gap-2">
          <span className="w-16 text-center text-xs text-muted-foreground">warn</span>
          <span className="w-16 text-center text-xs text-muted-foreground">crit</span>
        </div>
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-t border-border/40">
        <span className="text-sm">CPU</span>
        <div className="flex items-center gap-2">
          <input type="number" min={1} max={99} placeholder="80" value={cpuWarn} onChange={(e) => setCpuWarn(e.target.value)} className={thresholdInput} aria-label="CPU warning threshold" />
          <input type="number" min={2} max={100} placeholder="95" value={cpuCrit} onChange={(e) => setCpuCrit(e.target.value)} className={thresholdInput} aria-label="CPU critical threshold" />
        </div>
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-t border-border/40">
        <span className="text-sm">Memory</span>
        <div className="flex items-center gap-2">
          <input type="number" min={1} max={99} placeholder="85" value={memWarn} onChange={(e) => setMemWarn(e.target.value)} className={thresholdInput} aria-label="Memory warning threshold" />
          <input type="number" min={2} max={100} placeholder="95" value={memCrit} onChange={(e) => setMemCrit(e.target.value)} className={thresholdInput} aria-label="Memory critical threshold" />
        </div>
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-t border-border/40">
        <span className="text-sm text-muted-foreground">Disk</span>
        <div className="flex items-center gap-2">
          <span className="w-16 text-center text-sm text-muted-foreground tabular-nums">80%</span>
          <span className="w-16 text-center text-sm text-muted-foreground tabular-nums">90%</span>
        </div>
      </div>
      {(cpuWarn || cpuCrit || memWarn || memCrit) && (
        <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-border/40">
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={clearThresholds}>
            Clear
          </Button>
          <Button size="sm" className="h-7 text-xs px-4" disabled={saving} onClick={saveThresholds}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
}

// ── Notification channels (webhook, ntfy, email) ─────────────────────────────

interface NotificationChannel {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: {
    url?: string;
    topic?: string;
    filter?: { levels?: string[]; categories?: string[] };
  };
}

function NotificationChannelsSection() {
  const { data: channels, mutate } = useSWR<NotificationChannel[]>(
    `${CORE_URL}/api/notification-channels`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );

  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState<"webhook" | "ntfy" | "email">("ntfy");
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [newSmtpHost, setNewSmtpHost] = useState("");
  const [newSmtpPort, setNewSmtpPort] = useState("587");
  const [newSmtpUser, setNewSmtpUser] = useState("");
  const [newSmtpPass, setNewSmtpPass] = useState("");
  const [newEmailFrom, setNewEmailFrom] = useState("");
  const [newEmailTo, setNewEmailTo] = useState("");
  const [newLevels, setNewLevels] = useState<string[]>(["warning", "critical"]);
  const [saving, setSaving] = useState(false);

  const addChannel = async () => {
    if (!newName) return;
    if (newType !== "email" && !newUrl) return;
    if (newType === "email" && (!newSmtpHost || !newEmailFrom || !newEmailTo)) return;
    setSaving(true);
    try {
      let config: Record<string, unknown>;
      if (newType === "email") {
        config = {
          smtpHost: newSmtpHost,
          smtpPort: parseInt(newSmtpPort) || 587,
          useTls: true,
          username: newSmtpUser || undefined,
          password: newSmtpPass || undefined,
          from: newEmailFrom,
          to: newEmailTo.split(",").map((s) => s.trim()).filter(Boolean),
        };
      } else {
        config = { url: newUrl };
        if (newType === "ntfy" && newTopic) config.topic = newTopic;
      }
      if (newLevels.length > 0 && newLevels.length < 2) {
        config.filter = { levels: newLevels };
      }
      const res = await fetch(`${CORE_URL}/api/notification-channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, name: newName, config }),
      });
      if (res.ok) {
        toast.success(`Channel "${newName}" added`);
        setAdding(false);
        setNewName("");
        setNewUrl("");
        setNewTopic("");
        setNewLevels(["warning", "critical"]);
        mutate();
      } else {
        toast.error("Failed to add channel");
      }
    } catch {
      toast.error("Failed to add channel");
    } finally {
      setSaving(false);
    }
  };

  const removeChannel = async (id: string, name: string) => {
    try {
      await fetch(`${CORE_URL}/api/notification-channels/${id}`, { method: "DELETE" });
      toast.success(`Removed "${name}"`);
      mutate();
    } catch {
      toast.error("Failed to remove channel");
    }
  };

  const testChannel = async (id: string) => {
    try {
      const res = await fetch(`${CORE_URL}/api/notification-channels/${id}/test`, { method: "POST" });
      const data = await res.json();
      if (data.ok) toast.success("Test notification sent");
      else toast.error(data.error ?? "Test failed");
    } catch {
      toast.error("Test failed");
    }
  };

  const updateChannelLevels = async (channel: NotificationChannel, levels: string[]) => {
    try {
      const config = { ...channel.config, filter: { ...channel.config.filter, levels } };
      await fetch(`${CORE_URL}/api/notification-channels/${channel.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      mutate();
    } catch {
      toast.error("Failed to update filter");
    }
  };

  return (
    <div className="grid gap-2">
      {channels && channels.length > 0 && (
        <SettingsGroup>
          {channels.map((ch) => {
            const currentLevels = ch.config.filter?.levels ?? ["warning", "critical"];
            return (
              <SettingsRow key={ch.id} className="flex-wrap gap-y-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{ch.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {ch.type === "ntfy" && ch.config.topic
                      ? `${ch.config.url}/${ch.config.topic}`
                      : ch.type === "email"
                        ? ch.type
                        : ch.config.url}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <LevelPicker
                    value={currentLevels}
                    onChange={(levels) => updateChannelLevels(ch, levels)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2"
                    onClick={() => testChannel(ch.id)}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2 text-destructive/70 hover:text-destructive"
                    onClick={() => removeChannel(ch.id, ch.name)}
                  >
                    Remove
                  </Button>
                </div>
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      )}

      {adding ? (
        <SettingsGroup>
          <div className="px-4 py-2.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">New channel</span>
          </div>
          <SettingsRow className="flex-wrap gap-y-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">Type</p>
            </div>
            <div className="flex items-center gap-1.5">
              {(["ntfy", "webhook", "email"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setNewType(t)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    newType === t
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "bg-muted/50 text-muted-foreground border border-transparent hover:bg-muted"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
            <p className="text-sm font-medium flex-1">Name</p>
            <input
              type="text"
              placeholder="e.g. My Phone"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="h-8 w-full sm:w-48 rounded-md border border-border bg-input px-3 text-sm"
            />
          </SettingsRow>
          {newType !== "email" && (
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <p className="text-sm font-medium flex-1">URL</p>
              <input
                type="text"
                placeholder={newType === "ntfy" ? "https://ntfy.sh" : "https://webhook.site/..."}
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="h-8 w-full sm:w-64 rounded-md border border-border bg-input px-3 text-sm"
              />
            </SettingsRow>
          )}
          {newType === "ntfy" && (
            <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
              <p className="text-sm font-medium flex-1">Topic</p>
              <input
                type="text"
                placeholder="my-talome-alerts"
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                className="h-8 w-full sm:w-48 rounded-md border border-border bg-input px-3 text-sm"
              />
            </SettingsRow>
          )}
          {newType === "email" && (
            <>
              <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
                <p className="text-sm font-medium flex-1">SMTP Host</p>
                <input type="text" placeholder="smtp.gmail.com" value={newSmtpHost} onChange={(e) => setNewSmtpHost(e.target.value)} className="h-8 w-full sm:w-48 rounded-md border border-border bg-input px-3 text-sm" />
              </SettingsRow>
              <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
                <p className="text-sm font-medium flex-1">SMTP Port</p>
                <input type="text" placeholder="587" value={newSmtpPort} onChange={(e) => setNewSmtpPort(e.target.value)} className="h-8 w-20 rounded-md border border-border bg-input px-3 text-sm" />
              </SettingsRow>
              <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
                <p className="text-sm font-medium flex-1">Username</p>
                <input type="text" placeholder="optional" value={newSmtpUser} onChange={(e) => setNewSmtpUser(e.target.value)} className="h-8 w-full sm:w-48 rounded-md border border-border bg-input px-3 text-sm" />
              </SettingsRow>
              <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
                <p className="text-sm font-medium flex-1">Password</p>
                <input type="password" placeholder="optional" value={newSmtpPass} onChange={(e) => setNewSmtpPass(e.target.value)} className="h-8 w-full sm:w-48 rounded-md border border-border bg-input px-3 text-sm" />
              </SettingsRow>
              <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
                <p className="text-sm font-medium flex-1">From</p>
                <input type="email" placeholder="alerts@example.com" value={newEmailFrom} onChange={(e) => setNewEmailFrom(e.target.value)} className="h-8 w-full sm:w-48 rounded-md border border-border bg-input px-3 text-sm" />
              </SettingsRow>
              <SettingsRow className="flex-wrap sm:flex-nowrap gap-y-2">
                <p className="text-sm font-medium flex-1">To</p>
                <input type="text" placeholder="you@example.com" value={newEmailTo} onChange={(e) => setNewEmailTo(e.target.value)} className="h-8 w-full sm:w-64 rounded-md border border-border bg-input px-3 text-sm" />
              </SettingsRow>
            </>
          )}
          <SettingsRow>
            <p className="text-sm font-medium flex-1">Send for</p>
            <LevelPicker value={newLevels} onChange={setNewLevels} />
          </SettingsRow>
          <SettingsRow className="bg-muted/30 justify-end gap-2 py-3">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs px-4"
              disabled={saving || !newName || (newType !== "email" && !newUrl)}
              onClick={addChannel}
            >
              {saving ? "Adding..." : "Add Channel"}
            </Button>
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs justify-self-start"
          onClick={() => setAdding(true)}
        >
          Add channel
        </Button>
      )}
    </div>
  );
}

// ── Main notifications section ───────────────────────────────────────────────

export function NotificationsSection() {
  return (
    <div className="grid gap-8">
      <p className="text-sm text-muted-foreground">
        Choose when alerts fire and where they go.
      </p>

      <AlertThresholdsSection />

      <NotificationChannelsSection />

      <ConfigureWithAI prompt="I'd like to set up notifications" />
    </div>
  );
}
