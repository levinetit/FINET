import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ieșire autonomă pentru imaginea Docker (vezi Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
