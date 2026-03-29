import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
    ],
  },
  title: "Talome — The Self-Evolving Server",
  description:
    "Open-source platform with AI that installs your apps, wires your services, and rewrites its own code to get better. Self-hosting, evolved.",
  openGraph: {
    title: "Talome — The Self-Evolving Server",
    description:
      "Open-source platform with AI that installs your apps, wires your services, and rewrites its own code to get better.",
    type: "website",
    siteName: "Talome",
  },
  twitter: {
    card: "summary_large_image",
    title: "Talome — The Self-Evolving Server",
    description:
      "Self-hosting, evolved. AI that manages your server and improves its own code.",
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
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <DocsProvider>{children}</DocsProvider>
      </body>
    </html>
  );
}
