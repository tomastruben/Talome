import { Logo } from "@/components/logo";
import Link from "next/link";

const productLinks = [
  { title: "Features", href: "#features" },
  { title: "How It Works", href: "#how-it-works" },
  { title: "Apps", href: "#apps" },
];

const communityLinks = [
  { title: "GitHub", href: "https://github.com/talomehq/talome" },
  { title: "Discord", href: "https://discord.gg/HK7gFaVRJ" },
  { title: "Docs", href: "/docs" },
];

const legalLinks = [
  { title: "Privacy Policy", href: "/docs/legal/privacy-policy" },
  { title: "Terms of Service", href: "/docs/legal/terms-of-service" },
];


export default function FooterSection() {
  return (
    <footer className="border-t border-border/8 py-16 md:py-20">
      <div className="mx-auto max-w-5xl px-6">
        {/* Top — logo + link columns */}
        <div className="flex flex-col gap-12 md:flex-row md:items-start md:justify-between">
          <Link href="/" aria-label="go home">
            <Logo />
          </Link>

          <div className="flex gap-16 text-sm">
            <div>
              <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground/30">
                Product
              </p>
              <ul className="space-y-3">
                {productLinks.map((link) => (
                  <li key={link.title}>
                    <Link
                      href={link.href}
                      className="text-muted-foreground/60 transition-colors duration-150 hover:text-foreground"
                    >
                      {link.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground/30">
                Community
              </p>
              <ul className="space-y-3">
                {communityLinks.map((link) => (
                  <li key={link.title}>
                    <Link
                      href={link.href}
                      className="text-muted-foreground/60 transition-colors duration-150 hover:text-foreground"
                    >
                      {link.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground/30">
                Legal
              </p>
              <ul className="space-y-3">
                {legalLinks.map((link) => (
                  <li key={link.title}>
                    <Link
                      href={link.href}
                      className="text-muted-foreground/60 transition-colors duration-150 hover:text-foreground"
                    >
                      {link.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Attribution */}
        <div className="mt-14 border-t border-border/6 pt-10 text-center">
          <p className="text-sm tracking-wide text-muted-foreground/40">
            Designed and built by Tomas Truben
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/20">
            Open source under AGPL-3.0. Talome is a server management tool — users are responsible for
            ensuring all content is obtained and used legally. All trademarks belong to their respective owners.
          </p>
        </div>
      </div>
    </footer>
  );
}
