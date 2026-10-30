/**
 * Consimțământul pentru analytics pe paginile publice (Faza 11, ADR 0027; Google Consent Mode v2).
 * Un cookie propriu, fără date personale: `finet_consent=granted|denied`. Implicit NIMIC nu se
 * încarcă și toate semnalele Consent Mode sunt `denied`; scriptul Google apare doar după „granted”.
 * Fără dependențe de server: îl folosesc componenta de client și testele.
 */
export const CONSENT_COOKIE = "finet_consent";
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 3600;

export type ConsentChoice = "granted" | "denied";

export function parseConsent(cookieHeader: string | null | undefined): ConsentChoice | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === CONSENT_COOKIE) return value === "granted" || value === "denied" ? value : null;
  }
  return null;
}

export function consentCookie(choice: ConsentChoice, secure: boolean): string {
  return `${CONSENT_COOKIE}=${choice}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Semnalele Consent Mode v2 pentru fiecare alegere (implicit și la lipsa alegerii: toate `denied`). */
export function consentSignals(choice: ConsentChoice | null): Record<string, "granted" | "denied"> {
  const analytics = choice === "granted" ? "granted" : "denied";
  return {
    analytics_storage: analytics,
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}
