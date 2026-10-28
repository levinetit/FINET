import type { NextConfig } from "next";

import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Ieșire autonomă pentru imaginea Docker (vezi Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Asset-urile statice nu trec prin `src/proxy.ts` (matcher-ul le exclude); primesc aici
  // antetele fixe (fără CSP, care cere nonce și e pus de proxy pe restul răspunsurilor).
  // Doar această cale, ca antetele să nu apară de două ori pe răspunsurile proxy-ului.
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;
