import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { fontDisplay, fontMono, fontSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "FINET",
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

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ro" className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
