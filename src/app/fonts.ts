import localFont from "next/font/local";

// Fonturi servite local (fără CDN); detalii despre surse în `fonts/README.md`.
export const fontDisplay = localFont({
  src: "./fonts/bricolage-grotesque-var.woff2",
  weight: "200 800",
  style: "normal",
  display: "swap",
  variable: "--font-bricolage",
});

export const fontSans = localFont({
  src: "./fonts/ibm-plex-sans-var.woff2",
  weight: "100 700",
  style: "normal",
  display: "swap",
  variable: "--font-plex-sans",
});

export const fontMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-plex-mono",
});
