"use client";

import { SettingsGroup, SettingsRow } from "@/components/settings/settings-primitives";

export function LegalSection() {
  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Please review the following information about your responsibilities when
        using Talome.
      </p>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            User Responsibility
          </p>
        </SettingsRow>

        <SettingsRow>
          <div className="flex-1 min-w-0 space-y-3">
            <p className="text-sm leading-relaxed">
              Talome is a self-hosted server management platform. It provides
              tools for organizing, managing, and accessing media and
              applications that you own or have legal rights to use.
            </p>
            <p className="text-sm leading-relaxed">
              Talome does not host, distribute, or provide access to copyrighted
              content. Features that interact with download clients, indexers, or
              third-party services are provided as neutral tools — similar to a
              web browser or file manager.
            </p>
            <p className="text-sm leading-relaxed font-medium">
              You are solely responsible for ensuring that your use of Talome and
              any connected services complies with all applicable laws in your
              jurisdiction, including but not limited to copyright law, digital
              rights management regulations, and terms of service of third-party
              platforms.
            </p>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Download Services
          </p>
        </SettingsRow>

        <SettingsRow>
          <div className="flex-1 min-w-0 space-y-3">
            <p className="text-sm leading-relaxed">
              Talome can integrate with download clients (such as qBittorrent),
              indexers (such as Prowlarr), and media managers (such as Sonarr and
              Radarr). These are independently developed, general-purpose tools
              with legitimate uses.
            </p>
            <p className="text-sm leading-relaxed">
              Talome does not control, endorse, or take responsibility for any
              content you access, download, or manage using these services. The
              legality of downloading specific content varies by jurisdiction and
              depends on the content itself, its licensing, and your local laws.
            </p>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Content Import & DRM
          </p>
        </SettingsRow>

        <SettingsRow>
          <div className="flex-1 min-w-0 space-y-3">
            <p className="text-sm leading-relaxed">
              Some features allow importing content from external services using
              tools you have installed on your system. Talome does not include or
              distribute any DRM circumvention software.
            </p>
            <p className="text-sm leading-relaxed">
              If you choose to install and use third-party tools for content
              conversion, you are responsible for ensuring your use complies with
              applicable laws, including the Digital Millennium Copyright Act
              (DMCA) in the United States and equivalent legislation in other
              jurisdictions.
            </p>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow className="py-2.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Disclaimer
          </p>
        </SettingsRow>

        <SettingsRow>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground leading-relaxed font-mono">
              THIS SOFTWARE IS PROVIDED &quot;AS IS&quot;, WITHOUT WARRANTY OF
              ANY KIND, EXPRESS OR IMPLIED. THE AUTHORS AND CONTRIBUTORS ARE NOT
              RESPONSIBLE FOR HOW THIS SOFTWARE IS USED. USERS ARE SOLELY
              RESPONSIBLE FOR ENSURING THEIR USE COMPLIES WITH ALL APPLICABLE
              LAWS IN THEIR JURISDICTION.
            </p>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
