import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

import {
  STATIC_SECURITY_HEADERS,
  applySecurityHeaders,
  buildCsp,
  createNonce,
} from "./security-headers";

describe("buildCsp", () => {
  it("producție: nonce pe scripturi și stiluri, fără unsafe-*", () => {
    const csp = buildCsp("abc", { development: false });
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self' 'nonce-abc'; " +
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  it("dezvoltare: unsafe-eval pe scripturi și unsafe-inline pe stiluri, restul identic", () => {
    const csp = buildCsp("abc", { development: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'unsafe-eval';");
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("createNonce", () => {
  it("128 de biți în base64, diferit la fiecare apel", () => {
    const values = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(values.size).toBe(50);
    for (const v of values) expect(v).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("applySecurityHeaders", () => {
  it("suprascrie valorile existente (nu le dublează)", () => {
    const headers = new Headers({ "X-Frame-Options": "SAMEORIGIN" });
    applySecurityHeaders(headers, "default-src 'self'");
    applySecurityHeaders(headers, "default-src 'self'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});

describe("next.config.ts: asset-urile statice", () => {
  it("primesc antetele fixe (fără CSP) doar pe /_next/static/", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule!.source).toBe("/_next/static/:path*");
    const names = rule!.headers.map((h) => h.key);
    expect(names).toEqual(Object.keys(STATIC_SECURITY_HEADERS));
    expect(names).not.toContain("Content-Security-Policy");
  });
});
