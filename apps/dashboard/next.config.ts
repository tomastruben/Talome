import type { NextConfig } from "next";

const CORE_BACKEND = process.env.NEXT_PUBLIC_CORE_URL || "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  output: "standalone",
  images: { unoptimized: true },
  allowedDevOrigins: ["*.local", "*.orb.local", "*.ts.net"],
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
