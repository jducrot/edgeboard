import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Request-time rendering with per-fetch revalidation suits live sports data
     better than cache components. */
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
