import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local launcher uses next dev; its corner badge covers mobile navigation.
  devIndicators: false,
  ...(process.env.PROMPTMASTER_COMMUNITY_E2E === "true" ? { distDir: ".next/community-e2e" } : {}),
  ...(process.env.PROMPTMASTER_PELICAN_E2E === "true" ? { distDir: ".next/pelican-e2e" } : {}),
  turbopack: {
    root: process.cwd(),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
