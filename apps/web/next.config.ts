import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return [
      // Mintlify /docs rewrites so to be in redop.useagents.site/docs
      {
        source: "/docs",
        destination: "https://redop.mintlify.dev/docs",
      },
      {
        source: "/docs/:match*",
        destination: "https://redop.mintlify.dev/docs/:match*",
      },
    ];
  },
};

export default nextConfig;
