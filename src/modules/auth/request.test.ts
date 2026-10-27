import { describe, expect, it } from "vitest";

import {
  CLIENT_IP_HEADER,
  describeDevice,
  emailSchema,
  normalizeEmail,
  parseClientHeader,
  sessionUserAgent,
  trustedClientIp,
  truncateIp,
  withTrustedClientIp,
} from "./request";

describe("normalizarea emailului", () => {
  it("trim + litere mici (aceeași regulă ca CHECK-ul din bază)", () => {
    expect(normalizeEmail("  Ana.Pop@Exemplu.RO \n")).toBe("ana.pop@exemplu.ro");
    expect(emailSchema.parse(" ION@exemplu.ro ")).toBe("ion@exemplu.ro");
    expect(emailSchema.safeParse("nu-e-email").success).toBe(false);
    expect(emailSchema.safeParse(`${"a".repeat(250)}@x.ro`).success).toBe(false);
  });
});

describe("IP-ul de încredere", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("fără Access verificat, antetele clientului sunt ignorate", () => {
    const headers = h({ "cf-connecting-ip": "203.0.113.7", [CLIENT_IP_HEADER]: "198.51.100.1" });
    expect(trustedClientIp(headers, { accessVerified: false })).toBeNull();
    const out = withTrustedClientIp(headers, { accessVerified: false });
    expect(out.get(CLIENT_IP_HEADER)).toBeNull();
  });

  it("cu Access verificat, se folosește cf-connecting-ip (validat), nu antetul trimis de client", () => {
    const headers = h({ "cf-connecting-ip": "203.0.113.7", [CLIENT_IP_HEADER]: "198.51.100.1" });
    expect(withTrustedClientIp(headers, { accessVerified: true }).get(CLIENT_IP_HEADER)).toBe(
      "203.0.113.7",
    );
    expect(
      trustedClientIp(h({ "cf-connecting-ip": "nu-e-ip" }), { accessVerified: true }),
    ).toBeNull();
    expect(
      trustedClientIp(h({ "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }), { accessVerified: true }),
    ).toBeNull();
  });

  it("trunchiază IP-ul pentru afișare", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.x");
    expect(truncateIp("2001:db8:1:2::5")).toBe("2001:db8:1::/48");
    expect(truncateIp("::ffff:192.0.2.4")).toBe("192.0.2.x");
    expect(truncateIp("nimic")).toBeNull();
    expect(truncateIp(null)).toBeNull();
  });
});

describe("clientul mobil (X-FINET-Client)", () => {
  it("acceptă doar android/<versiune> scurt", () => {
    expect(parseClientHeader("android/1.2.3")).toEqual({ platform: "android", version: "1.2.3" });
    expect(parseClientHeader("android/1.0.0-beta.1")).toEqual({
      platform: "android",
      version: "1.0.0-beta.1",
    });
    for (const bad of [
      "ios/1.0",
      "android/",
      "android/1.2.3<script>",
      `android/${"1".repeat(50)}`,
    ]) {
      expect(parseClientHeader(bad)).toBeNull();
    }
  });

  it("sesiunea mobilă e marcată, iar user-agent-ul web e curățat și trunchiat", () => {
    expect(sessionUserAgent(new Headers({ "x-finet-client": "android/2.0" }), "okhttp/4")).toBe(
      "FINET-Android/2.0",
    );
    expect(sessionUserAgent(new Headers(), "Mozilla\u0000/5.0")).toBe("Mozilla/5.0");
    expect(sessionUserAgent(new Headers(), "x".repeat(1000))?.length).toBe(256);
    expect(describeDevice("FINET-Android/2.0")).toBe("Telefon Android");
    expect(
      describeDevice(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
      ),
    ).toBe("Chrome pe Linux");
    expect(describeDevice(null)).toBe("Dispozitiv necunoscut");
  });
});
