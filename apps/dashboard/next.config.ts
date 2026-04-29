import type { NextConfig } from "next";

const CORE_BACKEND = process.env.NEXT_PUBLIC_CORE_URL || "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  output: "standalone",
  images: { unoptimized: true },
  // Allow dev-mode HMR from Tailscale (100.64.0.0/10 CGNAT — raw IP), Tailscale
  // MagicDNS (*.ts.net), Bonjour/mDNS (*.local), OrbStack (*.orb.local), and
  // common LAN ranges. Without these, dashboard dev mode 500s when accessed
  // off-loopback because webpack-hmr requests are rejected as cross-origin.
  // Next.js's matcher requires segment-count parity: "100.*" matches 100.x
  // (2 parts), not 100.67.194.97 (4 parts). For IPv4 we need 4-segment globs.
  allowedDevOrigins: [
    "*.local", "*.orb.local", "*.ts.net",
    "100.*.*.*",                    // Tailscale CGNAT (100.64.0.0/10)
    "192.168.*.*",                  // RFC1918 LAN
    "10.*.*.*",                     // RFC1918 LAN
    "172.*.*.*",                    // RFC1918 (covers 172.16/12)
  ],
  experimental: {
    optimizePackageImports: ["@hugeicons/core-free-icons", "@hugeicons/react"],
  },
  async redirects() {
    return [
      { source: "/dashboard/agent", destination: "/dashboard/intelligence", permanent: true },
      { source: "/dashboard/evolution", destination: "/dashboard/intelligence", permanent: true },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${CORE_BACKEND}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
