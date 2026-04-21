import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { githubUrl } from "@/lib/shared";
import { Logo } from "@/components/logo";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{
        title: <Logo />,
        url: "/",
      }}
      sidebar={{
        defaultOpenLevel: 1,
        banner: (
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-primary">Public Alpha</span> — Talome and these docs are under active development.
          </div>
        ),
      }}
      githubUrl={githubUrl}
      themeSwitch={{ enabled: false }}
    >
      {children}
    </DocsLayout>
  );
}
