import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { ChunkRecovery } from "@/components/app/chunk-recovery";
import { ServiceWorkerRegistration } from "@/components/app/pwa";

import { THEME_COOKIE, forcedTheme } from "./_lib/theme";
import { fontDisplay, fontMono, fontSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FINET", template: "%s · FINET" },
  description: "Finanțe personale și de familie",
  // Modul `personal` nu se indexează (master prompt 3.3).
  robots: { index: false, follow: false },
  // Faza 9 (ADR 0020): iconițele și modul „aplicație” pe iOS. Manifestul e legat manual în
  // `<head>` (mai jos), cu `crossOrigin="use-credentials"`.
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "FINET", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f5f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1412" },
  ],
};

/**
 * Layout-ul rădăcină. Citirea cookie-urilor face TOATE paginile dinamice: nonce-ul CSP
 * (`src/proxy.ts`) se aplică doar la randarea per cerere (o pagină statică ar avea scripturi
 * fără nonce, blocate de CSP).
 */
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const theme = forcedTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="ro"
      data-theme={theme}
      className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}
    >
      <head>
        {/* Manifestul PWA CU credențiale: fără `crossOrigin`, browserul îl cere fără cookie, iar
            Cloudflare Access l-ar refuza (ADR 0020). `metadata.manifest` din Next nu pune
            atributul (decât pe Vercel preview), de aceea legătura e scrisă aici. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body>
        <ChunkRecovery />
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
