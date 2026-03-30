import { Logo } from "@/components/logo";
import Link from "next/link";

const productLinks = [
  { title: "Features", href: "#features" },
  { title: "Install", href: "#install" },
  { title: "Apps", href: "#apps" },
];

const communityLinks = [
  { title: "GitHub", href: "https://github.com/tomastruben/Talome" },
  { title: "Discord", href: "https://discord.gg/HK7gFaVRJ" },
  { title: "Docs", href: "/docs" },
];

const legalLinks = [
  { title: "Privacy", href: "/docs/legal/privacy-policy" },
  { title: "Terms", href: "/docs/legal/terms-of-service" },
];


export default function FooterSection() {
  return (
    <footer className="border-t border-border/6 py-20 md:py-28">
      <div className="mx-auto max-w-5xl px-6">
        {/* Navigation */}
        <div className="flex flex-col gap-12 md:flex-row md:items-start md:justify-between">
          <Link href="/" aria-label="go home">
            <Logo />
          </Link>

          <div className="flex gap-14 text-[13px] md:gap-20">
            <FooterColumn title="Product" links={productLinks} />
            <FooterColumn title="Community" links={communityLinks} />
            <FooterColumn title="Legal" links={legalLinks} />
          </div>
        </div>

        {/* Attribution — unhurried, considered */}
        <div className="mt-20 border-t border-border/4 pt-12">
          <div className="flex flex-col items-center gap-4">
            <p className="text-[13px] font-light tracking-wide text-muted-foreground/50">
              Designed and built by{" "}
              <Link
                href="https://github.com/tomastruben"
                className="text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                Tomas Truben
              </Link>
            </p>
            <div className="flex items-center gap-3 text-[11px] tracking-wide text-muted-foreground/25">
              <span>AGPL-3.0</span>
              <span className="text-muted-foreground/10">·</span>
              <span>v0.1.0</span>
              <span className="text-muted-foreground/10">·</span>
              <span>Public Alpha</span>
            </div>
            <p className="mt-6 max-w-sm text-center text-[11px] leading-[1.8] text-muted-foreground/20">
              Users are responsible for ensuring all content
              is obtained and used in compliance with applicable laws.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { title: string; href: string }[];
}) {
  return (
    <div>
      <p className="mb-4 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground/25">
        {title}
      </p>
      <ul className="space-y-3">
        {links.map((link) => (
          <li key={link.title}>
            <Link
              href={link.href}
              className="text-muted-foreground/50 transition-colors duration-200 hover:text-foreground"
            >
              {link.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
