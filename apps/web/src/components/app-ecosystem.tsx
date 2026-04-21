"use client";

import { useState } from "react";
import { Reveal } from "./reveal";

const SVG_BASE =
  "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/svg";
const PNG_BASE =
  "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png";

/** Icons with broken SVGs — use PNG which at least has the shape */
const PNG_SLUGS = new Set(["radarr", "vaultwarden", "ollama", "paperless-ngx"]);

/**
 * Per-icon CSS filter overrides for dark background visibility.
 * - Pure black icons (ollama, vaultwarden): invert to white
 * - Dark icons (radarr): brighten substantially
 * - Dark green (paperless-ngx): brighten + boost saturation
 */
const ICON_FILTERS: Record<string, string> = {
  ollama: "invert(1)",
  vaultwarden: "invert(1)",
  radarr: "brightness(1.6)",
  "paperless-ngx": "brightness(2.5) saturate(1.3)",
};

const apps = [
  { name: "Jellyfin", slug: "jellyfin" },
  { name: "Plex", slug: "plex" },
  { name: "Sonarr", slug: "sonarr" },
  { name: "Radarr", slug: "radarr" },
  { name: "qBittorrent", slug: "qbittorrent" },
  { name: "Overseerr", slug: "overseerr" },
  { name: "Prowlarr", slug: "prowlarr" },
  { name: "Pi-hole", slug: "pi-hole" },
  { name: "Vaultwarden", slug: "vaultwarden" },
  { name: "Home Assistant", slug: "home-assistant" },
  { name: "Ollama", slug: "ollama" },
  { name: "Immich", slug: "immich" },
  { name: "Paperless-ngx", slug: "paperless-ngx" },
  { name: "Nextcloud", slug: "nextcloud" },
  { name: "Gitea", slug: "gitea" },
  { name: "WireGuard", slug: "wireguard" },
];

const sources = ["Talome", "CasaOS", "Umbrel", "My Creations"];

function getIconUrl(slug: string): string {
  if (PNG_SLUGS.has(slug)) return `${PNG_BASE}/${slug}.png`;
  return `${SVG_BASE}/${slug}.svg`;
}

function AppIcon({ slug, name }: { slug: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const filter = ICON_FILTERS[slug];

  if (failed) {
    return (
      <div className="flex size-10 items-center justify-center rounded-lg text-sm font-medium text-muted-foreground/50">
        {name[0]}
      </div>
    );
  }

  return (
    <img
      src={getIconUrl(slug)}
      alt={name}
      width={40}
      height={40}
      loading="lazy"
      className="size-10 rounded-lg"
      style={filter ? { filter } : undefined}
      onError={() => setFailed(true)}
    />
  );
}

export default function AppEcosystem() {
  return (
    <section id="apps" className="py-24 md:py-40">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal>
          <div className="text-center">
            <h2 className="text-balance text-4xl font-medium tracking-tight lg:text-5xl">
              Four stores. One search bar.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
              Talome, CasaOS, Umbrel, and the apps you&rsquo;ll make up tonight
              at 11&nbsp;PM. Install featured stacks with pre-configured
              bundles. Describe a new app; watch it get built. Install with
              one click. Also &mdash; and we can&rsquo;t stress this enough
              &mdash; with one click.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.06}>
          <div className="mx-auto mt-16 grid max-w-3xl grid-cols-4 gap-1.5 sm:grid-cols-8 md:mt-24">
            {apps.map((app) => (
              <div
                key={app.slug}
                className="group flex flex-col items-center gap-2.5 rounded-2xl p-3 transition-all duration-150 hover:bg-white/[0.04]"
              >
                <div className="flex size-14 items-center justify-center rounded-xl bg-white/[0.08] transition-colors duration-150 group-hover:bg-white/[0.14]">
                  <AppIcon slug={app.slug} name={app.name} />
                </div>
                <span className="text-center text-[10px] leading-tight text-muted-foreground/50 transition-colors duration-150 group-hover:text-foreground/70">
                  {app.name}
                </span>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
            {sources.map((source) => (
              <span
                key={source}
                className="rounded-full border border-border/15 px-4 py-1.5 text-xs text-muted-foreground/60"
              >
                {source}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
