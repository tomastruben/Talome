"use client";

import { useState, useEffect, useRef, Fragment } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon, LinkSquare01Icon, Search01Icon } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CORE_URL } from "@/lib/constants";
import { toast } from "sonner";
import {
  SettingsGroup,
  SettingsRow,
  TextRow,
  SecretRow,
  ConnectionTestRow,
} from "@/components/settings/settings-primitives";
import { ConfigureWithAI } from "@/components/settings/configure-with-ai";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import type { Container } from "@talome/types";

/* ── Types ─────────────────────────────────────────────── */

interface ServiceState {
  url: string;
  key: string;
  keyEditing: boolean;
}

const DEFAULT_SERVICES: Record<string, ServiceState> = {
  sonarr:      { url: "http://localhost:8989", key: "", keyEditing: false },
  radarr:      { url: "http://localhost:7878", key: "", keyEditing: false },
  readarr:     { url: "http://localhost:8787", key: "", keyEditing: false },
  prowlarr:    { url: "http://localhost:9696", key: "", keyEditing: false },
  qbittorrent: { url: "http://localhost:8080", key: "", keyEditing: false },
  jellyfin:    { url: "http://localhost:8096", key: "", keyEditing: false },
  overseerr:   { url: "http://localhost:5055", key: "", keyEditing: false },
  plex:        { url: "http://localhost:32400", key: "", keyEditing: false },
  audiobookshelf: { url: "http://localhost:13378", key: "", keyEditing: false },
  audible:     { url: "", key: "", keyEditing: false },
};

const SERVICE_META: Record<string, { label: string; hint: string; hasKey: boolean; urlKey: string; apiKeyKey: string; keyLabel?: string }> = {
  sonarr:      { label: "Sonarr",      hint: "TV show management",           hasKey: true,  urlKey: "sonarr_url",      apiKeyKey: "sonarr_api_key" },
  radarr:      { label: "Radarr",      hint: "Movie management",             hasKey: true,  urlKey: "radarr_url",      apiKeyKey: "radarr_api_key" },
  readarr:     { label: "Readarr",     hint: "Book & audiobook management",  hasKey: true,  urlKey: "readarr_url",     apiKeyKey: "readarr_api_key" },
  prowlarr:    { label: "Prowlarr",    hint: "Indexer management",           hasKey: true,  urlKey: "prowlarr_url",    apiKeyKey: "prowlarr_api_key" },
  qbittorrent: { label: "qBittorrent", hint: "Torrent client",              hasKey: false, urlKey: "qbittorrent_url", apiKeyKey: "" },
  jellyfin:    { label: "Jellyfin",    hint: "Media server",               hasKey: true,  urlKey: "jellyfin_url",    apiKeyKey: "jellyfin_api_key" },
  overseerr:   { label: "Overseerr",   hint: "Media request management",    hasKey: true,  urlKey: "overseerr_url",   apiKeyKey: "overseerr_api_key" },
  plex:        { label: "Plex",        hint: "Media server",                hasKey: true,  urlKey: "plex_url",        apiKeyKey: "plex_token", keyLabel: "Token" },
  audiobookshelf: { label: "Audiobookshelf", hint: "Audiobook & podcast server", hasKey: true, urlKey: "audiobookshelf_url", apiKeyKey: "audiobookshelf_api_key", keyLabel: "Token" },
  audible: { label: "Audible", hint: "Amazon Audible library sync & import", hasKey: false, urlKey: "", apiKeyKey: "" },
};

const SERVICE_ORDER = ["sonarr", "radarr", "readarr", "prowlarr", "qbittorrent", "jellyfin", "overseerr", "plex", "audiobookshelf", "audible"];

const AUDIBLE_MARKETPLACES = [
  { value: "us", label: "United States" },
  { value: "uk", label: "United Kingdom" },
  { value: "de", label: "Germany" },
  { value: "fr", label: "France" },
  { value: "au", label: "Australia" },
  { value: "ca", label: "Canada" },
  { value: "it", label: "Italy" },
  { value: "in", label: "India" },
  { value: "jp", label: "Japan" },
  { value: "es", label: "Spain" },
  { value: "br", label: "Brazil" },
] as const;

/* ── Helpers ───────────────────────────────────────────── */

function extractPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/* ── Component ─────────────────────────────────────────── */

export function ConnectionsSection() {
  const [services, setServices] = useState<Record<string, ServiceState>>(DEFAULT_SERVICES);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [detectingPlex, setDetectingPlex] = useState(false);
  const [plexSigningIn, setPlexSigningIn] = useState(false);
  const plexPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const quickLook = useQuickLook();

  // Audible OAuth state
  const [audibleMarketplace, setAudibleMarketplace] = useState("us");
  const [audibleConnecting, setAudibleConnecting] = useState(false);
  const [audibleConnected, setAudibleConnected] = useState(false);
  const [audibleSessionId, setAudibleSessionId] = useState<string | null>(null);
  const [audiblePastedUrl, setAudiblePastedUrl] = useState("");

  const { data: containers } = useSWR<Container[]>(
    `${CORE_URL}/api/containers`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    return () => {
      if (plexPollRef.current) clearInterval(plexPollRef.current);
    };
  }, []);

  // Check Audible connection status on mount
  useEffect(() => {
    fetch(`${CORE_URL}/api/audible/auth-status`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) setAudibleConnected(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${CORE_URL}/api/settings`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        setServices((prev) => {
          const next = { ...prev };
          for (const id of SERVICE_ORDER) {
            const meta = SERVICE_META[id];
            next[id] = {
              ...next[id],
              url: data[meta.urlKey] || next[id].url,
              key: (meta.hasKey && data[meta.apiKeyKey]) ? data[meta.apiKeyKey] : next[id].key,
            };
          }
          return next;
        });
      })
      .catch(() => {});
  }, []);

  function update(id: string, patch: Partial<ServiceState>) {
    setServices((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    setDirty(true);
  }

  function getContainer(id: string, url: string): Container | null {
    const port = extractPort(url);
    if (!port) return null;

    // Try to find a real container matching this port
    const real = containers?.find(
      (c) => c.ports.some((p) => p.host === port && p.protocol === "tcp"),
    );
    if (real) return real;

    // Synthetic container so QuickLook can open the URL
    const meta = SERVICE_META[id];
    return {
      id: id,
      name: meta.label,
      image: id,
      status: "running",
      ports: [{ host: port, container: port, protocol: "tcp" }],
      created: new Date().toISOString(),
      labels: {},
    };
  }

  async function startPlexSignIn() {
    setPlexSigningIn(true);
    try {
      const res = await fetch(`${CORE_URL}/api/settings/plex-auth/pin`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        toast.error(data.error ?? "Failed to start Plex sign-in");
        setPlexSigningIn(false);
        return;
      }

      window.open(data.authUrl, "_blank");
      toast.info("Complete sign-in in the Plex tab, then come back here");

      let attempts = 0;
      plexPollRef.current = setInterval(async () => {
        attempts++;
        if (attempts > 150) {
          clearInterval(plexPollRef.current!);
          plexPollRef.current = null;
          setPlexSigningIn(false);
          toast.error("Plex sign-in timed out");
          return;
        }
        try {
          const pollRes = await fetch(`${CORE_URL}/api/settings/plex-auth/poll/${data.pinId}`);
          const pollData = await pollRes.json();
          if (pollData.ok && pollData.token) {
            clearInterval(plexPollRef.current!);
            plexPollRef.current = null;
            setPlexSigningIn(false);
            update("plex", { key: pollData.token, keyEditing: true });
            toast.success("Plex token obtained — click Save to apply");
          }
        } catch {
          // ignore poll errors, keep trying
        }
      }, 2000);
    } catch {
      toast.error("Failed to start Plex sign-in");
      setPlexSigningIn(false);
    }
  }

  async function startAudibleAuth() {
    setAudibleConnecting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/audible/auth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ marketplace: audibleMarketplace }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        toast.error(data.error ?? "Failed to start Audible sign-in");
        setAudibleConnecting(false);
        return;
      }

      setAudibleSessionId(data.sessionId ?? null);
      // Open in new tab — user needs to copy URL from address bar after login
      window.open(data.url, "_blank");
      setAudibleConnecting(false);
    } catch {
      toast.error("Failed to start Audible sign-in");
      setAudibleConnecting(false);
    }
  }

  async function disconnectAudible() {
    try {
      await fetch(`${CORE_URL}/api/audible/disconnect`, { method: "POST", credentials: "include" });
      setAudibleConnected(false);
      setAudiblePastedUrl("");
      toast.success("Audible disconnected");
    } catch {
      toast.error("Failed to disconnect Audible");
    }
  }

  async function submitAudiblePastedUrl() {
    if (!audiblePastedUrl.trim()) return;
    setAudibleConnecting(true);
    try {
      const res = await fetch(`${CORE_URL}/api/audible/auth/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId: audibleSessionId, url: audiblePastedUrl.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setAudibleConnected(true);
        setAudiblePastedUrl("");
        toast.success("Audible connected");
      } else {
        toast.error(data.error ?? "Failed to connect — check the URL and try again");
      }
    } catch {
      toast.error("Failed to connect to Audible");
    } finally {
      setAudibleConnecting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      for (const id of SERVICE_ORDER) {
        if (id === "audible") continue; // Audible uses OAuth, not URL+key
        const meta = SERVICE_META[id];
        const svc = services[id];
        body[meta.urlKey] = svc.url;
        if (meta.hasKey && (svc.keyEditing || svc.key)) {
          body[meta.apiKeyKey] = svc.key;
        }
      }
      await fetch(`${CORE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setServices((prev) => {
        const next = { ...prev };
        for (const id of SERVICE_ORDER) next[id] = { ...next[id], keyEditing: false };
        return next;
      });
      setDirty(false);
      toast.success("Connections saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Connect your media services so the assistant can search, request, and manage content for you.
      </p>

      <SettingsGroup>
        {SERVICE_ORDER.map((id, i) => {
          const meta = SERVICE_META[id];
          const svc = services[id];
          const container = id !== "audible" ? getContainer(id, svc.url) : null;

          return (
            <Fragment key={id}>
              {i > 0 && <div className="h-px bg-border/60 mx-4" />}

              {/* Service header */}
              <SettingsRow className="py-2.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {meta.label}
                </p>
                {container && (
                  <button
                    type="button"
                    onClick={() => quickLook.open(container)}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <HugeiconsIcon icon={LinkSquare01Icon} size={12} />
                    Open
                  </button>
                )}
              </SettingsRow>

              {id === "audible" ? (
                /* ── Audible OAuth section ── */
                <SettingsRow className="flex-col items-start gap-3 py-3">
                  {audibleConnected ? (
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-status-healthy" />
                        <span className="text-sm text-foreground">Connected</span>
                        <span className="text-xs text-muted-foreground">
                          {AUDIBLE_MARKETPLACES.find((m) => m.value === audibleMarketplace)?.label ?? ""}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => void disconnectAudible()}
                      >
                        Disconnect
                      </Button>
                    </div>
                  ) : (
                    <>
                      {/* Step 1: Select marketplace */}
                      <div className="flex items-center gap-2 w-full">
                        <Select value={audibleMarketplace} onValueChange={setAudibleMarketplace}>
                          <SelectTrigger className="h-8 text-xs min-w-[10rem]">
                            <SelectValue placeholder="Marketplace" />
                          </SelectTrigger>
                          <SelectContent>
                            {AUDIBLE_MARKETPLACES.map((m) => (
                              <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Step 2: Open Amazon login */}
                      <div className="space-y-1.5 w-full">
                        <p className="text-xs text-muted-foreground">
                          1. Click below to open the Amazon sign-in page
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs gap-1.5"
                          disabled={audibleConnecting}
                          onClick={() => void startAudibleAuth()}
                        >
                          {audibleConnecting ? <Spinner className="h-3 w-3" /> : <HugeiconsIcon icon={LinkSquare01Icon} size={12} />}
                          Open Amazon Login
                        </Button>
                      </div>

                      {/* Step 3: Paste redirect URL */}
                      <div className="space-y-1.5 w-full">
                        <p className="text-xs text-muted-foreground">
                          2. Sign in, then copy the URL from the address bar and paste it here
                        </p>
                        <div className="flex items-center gap-2 w-full">
                          <Input
                            className="h-8 text-xs flex-1"
                            placeholder="Paste the URL after sign-in..."
                            value={audiblePastedUrl}
                            onChange={(e) => setAudiblePastedUrl(e.target.value)}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs shrink-0"
                            disabled={!audiblePastedUrl.trim() || audibleConnecting}
                            onClick={() => void submitAudiblePastedUrl()}
                          >
                            {audibleConnecting ? <Spinner className="h-3 w-3" /> : "Connect"}
                          </Button>
                        </div>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        The page after sign-in will show an error — this is expected. Just copy the full URL.
                      </p>
                    </>
                  )}
                </SettingsRow>
              ) : (
                /* ── Standard URL + key fields ── */
                <>
                  <TextRow
                    label="URL"
                    hint={meta.hint}
                    id={`${id}-url`}
                    placeholder={DEFAULT_SERVICES[id].url}
                    value={svc.url}
                    onChange={(v) => update(id, { url: v })}
                  />

                  {meta.hasKey && (
                    <SecretRow
                      label={meta.keyLabel ?? "API Key"}
                      id={`${id}-key`}
                      placeholder={`Paste ${(meta.keyLabel ?? "key").toLowerCase()} from ${meta.label} → Settings`}
                      storedValue={svc.key}
                      isEditing={svc.keyEditing}
                      onEdit={() => update(id, { keyEditing: true, key: "" })}
                      onChange={(v) => update(id, { key: v })}
                    />
                  )}

                  {id === "plex" && (
                    <SettingsRow className="gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        disabled={plexSigningIn}
                        onClick={startPlexSignIn}
                      >
                        {plexSigningIn ? <Spinner className="h-3 w-3" /> : <HugeiconsIcon icon={LinkSquare01Icon} size={12} />}
                        Sign in with Plex
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        disabled={detectingPlex || plexSigningIn}
                        onClick={async () => {
                          setDetectingPlex(true);
                          try {
                            const res = await fetch(`${CORE_URL}/api/settings/detect-plex-token`, { method: "POST" });
                            const data = await res.json();
                            if (data.ok && data.token) {
                              update("plex", { key: data.token, keyEditing: true });
                              toast.success("Plex token detected");
                            } else {
                              toast.error(data.error ?? "Could not detect Plex token");
                            }
                          } catch {
                            toast.error("Failed to detect Plex token");
                          }
                          setDetectingPlex(false);
                        }}
                      >
                        {detectingPlex ? <Spinner className="h-3 w-3" /> : <HugeiconsIcon icon={Search01Icon} size={12} />}
                        Auto-detect from container
                      </Button>
                    </SettingsRow>
                  )}

                  <ConnectionTestRow service={id} url={svc.url} apiKey={svc.key} />
                </>
              )}
            </Fragment>
          );
        })}

        {/* Save */}
        <SettingsRow className="bg-muted/30 justify-end py-3">
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="h-7 text-xs px-4"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <ConfigureWithAI
        prompt="I'd like to review my media stack connections"
        label="Need help connecting services? Ask the assistant"
      />
    </div>
  );
}
