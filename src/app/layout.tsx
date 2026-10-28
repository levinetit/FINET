import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";

import { ChunkRecovery } from "@/components/app/chunk-recovery";

import { THEME_COOKIE, forcedTheme } from "./_lib/theme";
import { fontDisplay, fontMono, fontSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "FINET", template: "%s · FINET" },
  description: "Finanțe personale și de familie",
  // Modul `personal` nu se indexează (master prompt 3.3).
  robots: { index: false, follow: false },
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
      <body>
        <ChunkRecovery />
        {children}
      </body>
    </html>
  );
}
