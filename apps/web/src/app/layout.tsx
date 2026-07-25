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
  metadataBase: new URL("https://talome.dev"),
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
    ],
  },
  title: "Talome — Your Server, Now a Desktop That Thinks",
  description:
    "A self-hosted desktop workspace with AI that installs apps, connects services, fixes problems, and improves the system behind it.",
  openGraph: {
    title: "Talome — Your Server, Now a Desktop That Thinks",
    description:
      "A self-hosted desktop workspace with AI that installs apps, connects services, fixes problems, and improves the system behind it.",
    type: "website",
    siteName: "Talome",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Talome — Your Server, Now a Desktop That Thinks",
    description:
      "Your server, now a desktop that thinks. Self-hosted apps, files, media, terminals, and AI in one workspace.",
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
