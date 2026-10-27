/**
 * Rulează o dată, la pornirea serverului Next.js (nu la `next build`): validează configurația
 * și oprește procesul dacă e invalidă (`src/lib/config-startup.ts`). Importul dinamic ține
 * codul Node în afara compilării pentru Edge.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateConfigOrExit } = await import("@/lib/config-startup");
    validateConfigOrExit();
  }
}
