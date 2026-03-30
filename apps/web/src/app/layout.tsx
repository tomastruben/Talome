import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { DocsProvider } from "@/components/docs/provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://talome.dev"),
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
    ],
    apple: "/apple-touch-icon.png",
  },
  title: {
    default: "Talome — The Self-Evolving Server",
    template: "%s — Talome",
  },
  description:
    "Open-source platform with AI that installs your apps, wires your services, and rewrites its own code to get better. Self-hosting, evolved.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Talome — The Self-Evolving Server",
    description:
      "Open-source platform with AI that installs your apps, wires your services, and rewrites its own code to get better.",
    url: "https://talome.dev",
    type: "website",
    siteName: "Talome",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Talome — The Self-Evolving Server",
    description:
      "Self-hosting, evolved. AI that manages your server and improves its own code.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#1a1a1a" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "Talome",
              description:
                "Open-source, AI-first home server management platform. Install apps, wire services, and let AI improve its own code.",
              applicationCategory: "UtilitiesApplication",
              operatingSystem: "Linux, macOS",
              url: "https://talome.dev",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              license: "https://opensource.org/licenses/MIT",
            }),
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <DocsProvider>{children}</DocsProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
