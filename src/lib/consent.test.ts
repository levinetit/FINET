import { describe, expect, it } from "vitest";

import { CONSENT_COOKIE, consentCookie, consentSignals, parseConsent } from "./consent";
import { CONSUMER_LINKS, isPublicSitePath, isTurnstilePath } from "./site-paths";
import { buildCsp } from "./security-headers";

describe("consimțământul pentru analytics (Consent Mode v2)", () => {
  it("fără alegere sau cu valori străine: nimic acordat", () => {
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent("a=1; b=2")).toBeNull();
    expect(parseConsent(`${CONSENT_COOKIE}=poate`)).toBeNull();
    expect(consentSignals(null)).toEqual({
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });
  it("granted doar pentru analytics; reclamele rămân mereu denied", () => {
    expect(parseConsent(`x=1; ${CONSENT_COOKIE}=granted; y=2`)).toBe("granted");
    expect(consentSignals("granted")).toEqual({
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
    expect(consentSignals("denied").analytics_storage).toBe("denied");
  });
  it("cookie-ul: 180 de zile, Lax, Secure pe https", () => {
    expect(consentCookie("denied", false)).toBe(
      `${CONSENT_COOKIE}=denied; Path=/; Max-Age=15552000; SameSite=Lax`,
    );
    expect(consentCookie("granted", true)).toMatch(/; Secure$/);
  });
});

describe("paginile publice și CSP", () => {
  it("doar cele cinci pagini publice, cu sau fără slash final", () => {
    for (const p of ["/", "/pricing", "/terms", "/privacy", "/support", "/terms/"]) {
      expect(isPublicSitePath(p), p).toBe(true);
    }
    // `/register*` colectează parole: NICIODATĂ pagină cu analytics; `/help` e ghidul autentificat.
    const privateOnes = ["/dashboard", "/login", "/register", "/register/complete", "/help"];
    for (const p of [...privateOnes, "/api/v1/me", "/pricing/x", "/terms.html", ""]) {
      expect(isPublicSitePath(p), p).toBe(false);
    }
  });
  it("legăturile pentru consumatori sunt https către ANPC și platforma SOL", () => {
    expect(CONSUMER_LINKS.anpcSal).toMatch(/^https:\/\/anpc\.ro\//);
    expect(CONSUMER_LINKS.sol).toMatch(/^https:\/\/ec\.europa\.eu\//);
  });
  it("CSP: domeniile Google doar cu `analytics`", () => {
    const off = buildCsp("abc", { development: false });
    const on = buildCsp("abc", { development: false, analytics: true });
    expect(off).not.toContain("google");
    expect(on).toContain("script-src 'self' 'nonce-abc' https://www.googletagmanager.com");
    expect(on).toContain("connect-src 'self' https://www.google-analytics.com");
    expect(on).toContain("img-src 'self' data: https://www.google-analytics.com");
    // Restul directivelor neschimbate.
    expect(on).toContain("default-src 'self'");
    expect(on).toContain("frame-ancestors 'none'");
  });
});

describe("Turnstile și CSP (F11-C2)", () => {
  it("surse Cloudflare doar cu opțiunea `turnstile`, inclusiv frame-src; altfel nimic", () => {
    const off = buildCsp("abc", { development: false });
    expect(off).not.toContain("challenges.cloudflare.com");
    expect(off).not.toContain("frame-src");
    const on = buildCsp("abc", { development: false, turnstile: true });
    expect(on).toContain("script-src 'self' 'nonce-abc' https://challenges.cloudflare.com");
    expect(on).toContain("connect-src 'self' https://challenges.cloudflare.com");
    expect(on).toContain("frame-src https://challenges.cloudflare.com");
    // Restul rămâne strict.
    expect(on).toContain("default-src 'self'");
    expect(on).toContain("frame-ancestors 'none'");
    expect(on).not.toContain("unsafe-inline");
  });
  it("doar `/register` (cu sau fără slash final) încarcă Turnstile", () => {
    for (const p of ["/register", "/register/"]) expect(isTurnstilePath(p), p).toBe(true);
    for (const p of ["/register/complete", "/login", "/", "/support", "/registers", ""]) {
      expect(isTurnstilePath(p), p).toBe(false);
    }
  });
});
