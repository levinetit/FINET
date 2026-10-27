import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ARGON2_PARAMS,
  PASSWORD_MIN_LENGTH,
  checkPasswordLength,
  checkPasswordPolicy,
  hasArgon2,
  hashPassword,
  isPasswordCompromised,
  parseArgon2idHash,
  verifyPassword,
} from "./password";

describe("Argon2id (crypto.argon2 din Node)", () => {
  it("runtime-ul are crypto.argon2", () => {
    expect(hasArgon2()).toBe(true);
  });

  it("hash-ul e un șir PHC argon2id cu parametrii OWASP (m=19 MiB, t=2, p=1)", async () => {
    const hash = await hashPassword("parola-de-test-1");
    expect(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
    const parsed = parseArgon2idHash(hash);
    expect(parsed?.params).toEqual(ARGON2_PARAMS);
    expect(parsed?.salt.length).toBe(16);
    expect(parsed?.key.length).toBe(32);
    expect(hash).not.toContain("parola-de-test-1");
  });

  it("aceeași parolă dă hash-uri diferite (sare aleatoare) și se verifică", async () => {
    const a = await hashPassword("parola-de-test-2");
    const b = await hashPassword("parola-de-test-2");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "parola-de-test-2")).toBe(true);
    expect(await verifyPassword(b, "parola-de-test-2")).toBe(true);
    expect(await verifyPassword(a, "parola-de-test-3")).toBe(false);
  });

  it("verificarea aplică normalizarea NFKC (aceeași parolă, altă compunere Unicode)", async () => {
    const composed = "parolă-ț-ș-test";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const hash = await hashPassword(composed);
    expect(await verifyPassword(hash, decomposed)).toBe(true);
  });

  it("refuză hash-uri care nu sunt argon2id sau au parametri în afara limitelor", async () => {
    const hash = await hashPassword("parola-de-test-4");
    const [, , , , salt, key] = hash.split("$");
    const variants = [
      hash.replace("$argon2id$", "$argon2i$"),
      hash.replace("v=19", "v=16"),
      `$argon2id$v=19$m=4194304,t=2,p=1$${salt}$${key}`, // 4 GiB
      `$argon2id$v=19$m=1024,t=2,p=1$${salt}$${key}`, // sub minimul OWASP
      `$argon2id$v=19$m=19456,t=1,p=1$${salt}$${key}`,
      `$argon2id$v=19$m=19456,t=2,p=16$${salt}$${key}`,
      "scrypt:abc",
      "",
    ];
    for (const v of variants) {
      expect(parseArgon2idHash(v)).toBeNull();
      expect(await verifyPassword(v, "parola-de-test-4")).toBe(false);
    }
  });

  it("acceptă parametri mai puternici (creștere viitoare) la verificare", async () => {
    const strong = await hashPassword("parola-de-test-5", {
      memoryKiB: 32768,
      passes: 3,
      parallelism: 1,
    });
    expect(strong).toContain("m=32768,t=3,p=1");
    expect(await verifyPassword(strong, "parola-de-test-5")).toBe(true);
  });
});

describe("politica parolelor", () => {
  it(`minimum ${PASSWORD_MIN_LENGTH} caractere, maximum 128 (în puncte de cod)`, () => {
    expect(checkPasswordLength("a".repeat(9))).toBe("too_short");
    expect(checkPasswordLength("a".repeat(10))).toBeNull();
    expect(checkPasswordLength("ă".repeat(10))).toBeNull();
    expect(checkPasswordLength("a".repeat(129))).toBe("too_long");
  });

  it("HIBP e oprit implicit: nu se face niciun apel", async () => {
    const fetcher = vi.fn();
    expect(
      await checkPasswordPolicy("parola-lunga-ok", { hibpEnabled: false, fetcher }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("HIBP (k-anonymity): trimite doar prefixul de 5 caractere și potrivește local", async () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.pwnedpasswords.com/range/5BAA6");
      return {
        ok: true,
        text: async () =>
          "0000000000000000000000000000000000A:0\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:42\r\n",
      };
    });
    expect(await isPasswordCompromised("password", fetcher)).toBe(true);
    expect(
      await checkPasswordPolicy("password12", {
        hibpEnabled: true,
        fetcher: async () => ({ ok: true, text: async () => "" }),
      }),
    ).toBeNull();
    expect(fetcher.mock.calls[0]![0]).not.toContain("5BAA61E4C9");
  });

  it("o eroare de rețea HIBP nu blochează parola (fail open, documentat)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("rețea indisponibilă");
    });
    expect(await checkPasswordPolicy("parola-lunga-ok", { hibpEnabled: true, fetcher })).toBeNull();
  });

  it("o parolă compromisă e respinsă când HIBP e activat", async () => {
    const password = "parola-compromisa-123";
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
    const fetcher = async () => ({ ok: true, text: async () => `${sha1.slice(5)}:3` });
    expect(await checkPasswordPolicy(password, { hibpEnabled: true, fetcher })).toBe("compromised");
  });
});
