import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ACCESS_JWT_HEADER,
  createAccessVerifier,
  HEALTH_TOKEN_HEADER,
  healthTokenMatches,
  isAccessProtectedPath,
  isLocalProbe,
  isRequestAllowed,
  type AccessPolicy,
} from "@/lib/access";
import { guardAccess } from "@/lib/access-guard";
import { resetConfigForTests } from "@/lib/config";
import { referrerPolicyFor } from "@/lib/security-headers";
import { config as proxyConfig, proxy } from "@/proxy";

// Toate cheile și tokenurile sunt generate în test; nimic real.
const TEAM = "echipa-test.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "aud-test-finet";
const KID = "cheie-test-1";
const HEALTH_TOKEN = "t".repeat(40);

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JSONWebKeySet;
let localKeys: JWTVerifyGetKey;
let server: Server;
let serverMode: "ok" | "error" = "ok";
let jwksUrl: URL;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }] };
  localKeys = createLocalJWKSet(jwks);

  // Server JWKS local, în locul `https://<echipa>/cdn-cgi/access/certs`.
  server = createServer((_req, res) => {
    if (serverMode === "error") {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(jwks));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  jwksUrl = new URL(`http://127.0.0.1:${port}/cdn-cgi/access/certs`);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

type Claims = { aud?: string; iss?: string; exp?: number | string; sub?: string };

async function token(claims: Claims = {}, key: CryptoKey = privateKey, kid = KID): Promise<string> {
  const jwt = new SignJWT({ email: "membru@exemplu.invalid" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setSubject(claims.sub ?? "utilizator-test")
    .setIssuer(claims.iss ?? ISS)
    .setAudience(claims.aud ?? AUD);
  if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);
  else jwt.setExpirationTime("5m");
  return jwt.sign(key);
}

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    required: true,
    verify: createAccessVerifier({ teamDomain: TEAM, aud: AUD, keys: localKeys }),
    healthToken: null,
    ...overrides,
  };
}

function req(pathname: string, headers: Record<string, string> = {}, method = "GET") {
  return { method, pathname, headers: new Headers(headers) };
}

const now = () => Math.floor(Date.now() / 1000);

describe("verificarea JWT Cloudflare Access", () => {
  it("JWT valid → permis", async () => {
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: await token() }), policy())).toBe(
      true,
    );
  });

  it("JWT expirat → refuzat", async () => {
    const t = await token({ exp: now() - 120 });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: t }), policy())).toBe(false);
  });

  it("toleranță de ceas mică: expirat de 5 s → permis; de 60 s → refuzat", async () => {
    const p = policy();
    expect(
      await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: await token({ exp: now() - 5 }) }), p),
    ).toBe(true);
    expect(
      await isRequestAllowed(
        req("/", { [ACCESS_JWT_HEADER]: await token({ exp: now() - 60 }) }),
        p,
      ),
    ).toBe(false);
  });

  it("`aud` greșit → refuzat", async () => {
    const t = await token({ aud: "alta-aplicatie" });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: t }), policy())).toBe(false);
  });

  it("`iss` greșit → refuzat", async () => {
    const t = await token({ iss: "https://alta-echipa.cloudflareaccess.com" });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: t }), policy())).toBe(false);
  });

  it("semnătură greșită (altă cheie, același kid) → refuzat", async () => {
    const t = await token({}, otherPrivateKey);
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: t }), policy())).toBe(false);
  });

  it("token modificat după semnare → refuzat", async () => {
    const [h, , s] = (await token()).split(".");
    const payload = Buffer.from(JSON.stringify({ iss: ISS, aud: AUD, exp: now() + 300 })).toString(
      "base64url",
    );
    expect(
      await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: `${h}.${payload}.${s}` }), policy()),
    ).toBe(false);
  });

  it("algoritm HS256 sau `none` → refuzat (doar RS256)", async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("s".repeat(32)));
    const none = new UnsecuredJWT({})
      .setIssuer(ISS)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .encode();
    for (const t of [hs, none]) {
      expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: t }), policy())).toBe(false);
    }
  });

  it("JWT fără `exp` → refuzat", async () => {
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISS)
      .setAudience(AUD)
      .sign(privateKey);
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: t }), policy())).toBe(false);
  });

  it("antet lipsă, gol sau gunoi → refuzat", async () => {
    expect(await isRequestAllowed(req("/"), policy())).toBe(false);
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: "" }), policy())).toBe(false);
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: "a.b.c" }), policy())).toBe(
      false,
    );
    expect(
      await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: "x".repeat(9000) }), policy()),
    ).toBe(false);
  });

  it("JWKS servit prin HTTP (createRemoteJWKSet) → permis", async () => {
    serverMode = "ok";
    const p = policy({
      verify: createAccessVerifier({
        teamDomain: TEAM,
        aud: AUD,
        keys: createRemoteJWKSet(jwksUrl),
      }),
    });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: await token() }), p)).toBe(true);
  });
});

describe("FAIL-CLOSED", () => {
  it("JWKS răspunde cu eroare → 403 (refuzat, nu permis)", async () => {
    serverMode = "error";
    const p = policy({
      verify: createAccessVerifier({
        teamDomain: TEAM,
        aud: AUD,
        keys: createRemoteJWKSet(jwksUrl),
      }),
    });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: await token() }), p)).toBe(false);
    serverMode = "ok";
  });

  it("JWKS inaccesibil (port închis) → refuzat", async () => {
    const dead = new URL("http://127.0.0.1:1/cdn-cgi/access/certs");
    const p = policy({
      verify: createAccessVerifier({
        teamDomain: TEAM,
        aud: AUD,
        keys: createRemoteJWKSet(dead, { timeoutDuration: 500 }),
      }),
    });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: await token() }), p)).toBe(false);
  });

  it("verificatorul aruncă orice → refuzat", async () => {
    const p = policy({
      verify: async () => {
        throw new TypeError("neașteptat");
      },
    });
    expect(await isRequestAllowed(req("/", { [ACCESS_JWT_HEADER]: await token() }), p)).toBe(false);
  });

  it("Access obligatoriu fără verificator configurat → refuzat", async () => {
    expect(
      await isRequestAllowed(
        req("/", { [ACCESS_JWT_HEADER]: await token() }),
        policy({ verify: null }),
      ),
    ).toBe(false);
  });

  describe("proxy() în producție", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      resetConfigForTests();
    });

    function prodEnv(extra: Record<string, string> = {}) {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("APP_MODE", "personal");
      vi.stubEnv("STORAGE_DIR", "/tmp/finet-nu-se-foloseste");
      // F1-B: web în producție cere secretul Better Auth și APP_URL https (valori FICTIVE).
      vi.stubEnv("APP_URL", "https://finet.exemplu.invalid");
      vi.stubEnv("BETTER_AUTH_SECRET", "secret-fictiv-de-test-0123456789abcdef");
      // Domeniu `.invalid`: JWKS-ul nu poate fi obținut niciodată.
      vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", "echipa.invalid");
      vi.stubEnv("CF_ACCESS_AUD", AUD);
      vi.stubEnv("CF_ACCESS_REQUIRED", "");
      vi.stubEnv("HEALTH_TOKEN", "");
      // Izolare față de mediul în care rulează testele: rolul web nu acceptă URL-urile
      // workerului și migratorului (src/lib/config.ts).
      vi.stubEnv("FINET_ROLE", "");
      vi.stubEnv("WORKER_DATABASE_URL", "");
      vi.stubEnv("MIGRATOR_DATABASE_URL", "");
      for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
      resetConfigForTests();
    }

    async function call(path: string, headers: Record<string, string> = {}) {
      return proxy(new NextRequest(`https://finet.exemplu.invalid${path}`, { headers }));
    }

    async function local(path: string, method = "GET", headers: Record<string, string> = {}) {
      return proxy(
        new NextRequest(`http://127.0.0.1:3000${path}`, {
          method,
          headers: { host: "127.0.0.1:3000", ...headers },
        }),
      );
    }

    async function expectForbidden(res: Response) {
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        error: { code: "forbidden", message: "Acces interzis." },
      });
    }

    it("Faza 8: `Referrer-Policy: no-referrer` pe /join/<token>, implicitul în rest", async () => {
      prodEnv();
      for (const path of ["/join/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
        const res = await call(path);
        expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      }
      for (const path of [
        "/",
        "/family",
        "/joinx",
        "/login?next=%2Fjoin%2Fx",
        "/api/v1/invites/accept",
      ]) {
        expect((await call(path)).headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
      }
      // Ramura permisă (sondă locală de dezvoltare): același antet.
      expect(referrerPolicyFor("/join/abc")).toBe("no-referrer");
      expect(referrerPolicyFor("/login")).toBeNull();
      expect(referrerPolicyFor("/dashboard")).toBeNull();
    });

    it("antet lipsă → 403", async () => {
      prodEnv();
      await expectForbidden(await call("/"));
      await expectForbidden(await call("/api/health"));
    });

    it("Faza 9 (ADR 0020): fișierele PWA NU au excepție de la Access (403 fără JWT)", async () => {
      prodEnv();
      for (const path of [
        "/sw.js",
        "/manifest.webmanifest",
        "/icons/icon-192.png",
        "/icons/apple-touch-icon.png",
        "/offline",
        "/pwa/offline.js",
        "/pwa/offline.css",
        "/help",
        "/settings",
        "/settings/android",
        "/api/v1/app/android/latest",
        // F9-B (ADR 0021): GDPR și statistici, tot prin Access.
        "/settings/privacy",
        "/settings/statistics",
        "/api/v1/me/export",
        "/api/v1/me/deletion",
        "/api/v1/me/delete",
        "/api/v1/admin/stats",
      ]) {
        await expectForbidden(await call(path));
      }
    });

    it("JWT prezent, dar cheile Access nu pot fi obținute → 403 (nu 500, nu permis)", async () => {
      prodEnv();
      await expectForbidden(
        await call("/", { [ACCESS_JWT_HEADER]: await token({ iss: "https://echipa.invalid" }) }),
      );
    });

    it("CF_ACCESS_REQUIRED=false în producție → config refuză → 403 pe orice cale", async () => {
      prodEnv({ CF_ACCESS_REQUIRED: "false" });
      await expectForbidden(await call("/"));
      await expectForbidden(await call("/api/health"));
    });

    it("configurație invalidă (APP_MODE lipsă) → 403", async () => {
      prodEnv({ APP_MODE: "" });
      await expectForbidden(await call("/"));
    });

    it("HEALTH_TOKEN corect deschide doar /api/health", async () => {
      prodEnv({ HEALTH_TOKEN });
      const ok = await call("/api/health", { [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-middleware-next")).toBe("1");
      await expectForbidden(await call("/", { [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN }));
      await expectForbidden(await call("/api/health", { [HEALTH_TOKEN_HEADER]: "gresit" }));
    });

    it("liveness prin domeniul public (nu loopback) → 403", async () => {
      prodEnv();
      await expectForbidden(await call("/api/health/live"));
    });

    it("liveness local (healthcheck Docker) → trece", async () => {
      prodEnv();
      const res = await proxy(
        new NextRequest("http://127.0.0.1:3000/api/health/live", {
          headers: { host: "127.0.0.1:3000" },
        }),
      );
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("liveness local doar cu GET: HEAD, POST, PUT, DELETE, OPTIONS → 403", async () => {
      prodEnv();
      expect((await local("/api/health/live")).headers.get("x-middleware-next")).toBe("1");
      for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
        await expectForbidden(await local("/api/health/live", method));
      }
    });

    it("liveness cu Host loopback, dar X-Forwarded-For public → 403", async () => {
      prodEnv();
      await expectForbidden(
        await local("/api/health/live", "GET", { "x-forwarded-for": "203.0.113.7" }),
      );
    });

    it("variante ale căii de liveness nu primesc excepția → 403", async () => {
      prodEnv();
      for (const path of [
        "/api/health/live/",
        "/api/health/live%2f",
        "/api/health/live%2F",
        "/api/health/%6cive",
        "/api/health/live/x",
        "/api/health/live?x=1/",
        "/API/health/live",
      ]) {
        const res = await local(path);
        // `?x=1/` păstrează calea exactă: excepția se aplică (interogarea nu schimbă calea).
        if (path === "/api/health/live?x=1/") {
          expect(res.headers.get("x-middleware-next"), path).toBe("1");
        } else {
          await expectForbidden(res);
        }
      }
    });

    it("ruta exclusă din matcher (/api/v1/documents): aceeași verificare Access, înainte de handler", async () => {
      prodEnv();
      const run = vi.fn(async () => Response.json({ ok: true }));
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        const res = await guardAccess(
          new Request("https://finet.exemplu.invalid/api/v1/documents", {
            method,
            headers: { "content-type": "multipart/form-data; boundary=x" },
          }),
          run,
        );
        await expectForbidden(res);
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      }
      const withJwt = await guardAccess(
        new Request("https://finet.exemplu.invalid/api/v1/documents", {
          method: "POST",
          headers: { [ACCESS_JWT_HEADER]: await token({ iss: "https://echipa.invalid" }) },
        }),
        run,
      );
      await expectForbidden(withJwt);
      // Calea dată politicii e FIXĂ: nici o adresă de sănătate/liveness nu primește excepțiile.
      prodEnv({ HEALTH_TOKEN });
      for (const url of [
        "https://finet.exemplu.invalid/api/health",
        "http://127.0.0.1:3000/api/health/live",
      ]) {
        await expectForbidden(
          await guardAccess(
            new Request(url, {
              headers: { host: "127.0.0.1:3000", [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN },
            }),
            run,
          ),
        );
      }
      // HEALTH_TOKEN nu deschide ruta de încărcare.
      prodEnv({ HEALTH_TOKEN });
      await expectForbidden(
        await guardAccess(
          new Request("https://finet.exemplu.invalid/api/v1/documents", {
            method: "POST",
            headers: { [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN },
          }),
          run,
        ),
      );
      expect(run).not.toHaveBeenCalled();
    });

    it("ruta exclusă /api/v1/statements/uploads (Faza 7): aceeași verificare Access, pe calea ei fixă", async () => {
      prodEnv({ HEALTH_TOKEN });
      const run = vi.fn(async () => Response.json({ ok: true }));
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const res = await guardAccess(
          new Request("https://finet.exemplu.invalid/api/v1/statements/uploads", {
            method,
            headers: { "content-type": "multipart/form-data; boundary=x" },
          }),
          run,
          "/api/v1/statements/uploads",
        );
        await expectForbidden(res);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      }
      await expectForbidden(
        await guardAccess(
          new Request("http://127.0.0.1:3000/api/health/live", {
            headers: { host: "127.0.0.1:3000", [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN },
          }),
          run,
          "/api/v1/statements/uploads",
        ),
      );
      expect(run).not.toHaveBeenCalled();
    });

    describe("antetele de securitate (6.3)", () => {
      const nonceOf = (csp: string | null) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? "")?.[1];

      function expectSecurityHeaders(res: Response) {
        const csp = res.headers.get("content-security-policy");
        expect(csp).toBeTruthy();
        for (const directive of [
          "default-src 'self'",
          "img-src 'self' data:",
          "font-src 'self'",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ]) {
          expect(csp, directive).toContain(directive);
        }
        const nonce = nonceOf(csp);
        expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(csp).toContain(`script-src 'self' 'nonce-${nonce}';`);
        expect(csp).toContain(`style-src 'self' 'nonce-${nonce}';`);
        // În producție: fără `unsafe-*` și fără `strict-dynamic`.
        expect(csp).not.toMatch(/unsafe-|strict-dynamic/);
        expect(res.headers.get("strict-transport-security")).toBe(
          "max-age=31536000; includeSubDomains",
        );
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
        expect(res.headers.get("permissions-policy")).toBe(
          "camera=(self), microphone=(), geolocation=()",
        );
        // CORS închis.
        for (const name of res.headers.keys()) {
          expect(name.startsWith("access-control-allow-"), name).toBe(false);
        }
        return nonce!;
      }

      it("pe 403 (fără JWT): toate antetele, corpul și Cache-Control neschimbate", async () => {
        prodEnv();
        const res = await call("/login");
        expectSecurityHeaders(res);
        await expectForbidden(res);
      });

      it("pe 403 din configurația invalidă: antetele sunt tot acolo", async () => {
        prodEnv({ APP_MODE: "" });
        const res = await call("/");
        expectSecurityHeaders(res);
        await expectForbidden(res);
      });

      it("pe cererea permisă: antetele în răspuns și CSP-ul cu același nonce în cerere", async () => {
        prodEnv({ HEALTH_TOKEN });
        const res = await call("/api/health", { [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN });
        expect(res.headers.get("x-middleware-next")).toBe("1");
        const nonce = expectSecurityHeaders(res);
        // Next transmite randării antetele cererii modificate prin `x-middleware-request-*`.
        expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(
          res.headers.get("content-security-policy"),
        );
        expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
      });

      it("liveness local: antetele sunt prezente", async () => {
        prodEnv();
        const res = await local("/api/health/live");
        expect(res.headers.get("x-middleware-next")).toBe("1");
        expectSecurityHeaders(res);
      });

      it("nonce nou la fiecare cerere", async () => {
        prodEnv();
        const nonces = new Set<string>();
        for (let i = 0; i < 5; i++) nonces.add(expectSecurityHeaders(await call("/")));
        expect(nonces.size).toBe(5);
      });

      it("un x-nonce sau CSP trimis de client e înlocuit, nu păstrat", async () => {
        prodEnv({ HEALTH_TOKEN });
        const res = await call("/api/health", {
          [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN,
          "x-nonce": "nonce-de-la-client",
          "content-security-policy": "script-src *",
        });
        const nonce = expectSecurityHeaders(res);
        expect(nonce).not.toBe("nonce-de-la-client");
        expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
        expect(res.headers.get("x-middleware-request-content-security-policy")).not.toContain(
          "script-src *",
        );
      });
    });
  });

  it("în dezvoltare, cu CF_ACCESS_REQUIRED=false explicit, cererea trece", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_MODE", "personal");
    vi.stubEnv("CF_ACCESS_REQUIRED", "false");
    vi.stubEnv("FINET_ROLE", "");
    vi.stubEnv("WORKER_DATABASE_URL", "");
    vi.stubEnv("MIGRATOR_DATABASE_URL", "");
    resetConfigForTests();
    const res = await proxy(new NextRequest("http://localhost:3000/"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    // În dezvoltare CSP-ul permite `eval` (stivele de erori React) și stilurile inline (overlay).
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'unsafe-eval';/);
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).toContain("frame-ancestors 'none'");
    vi.unstubAllEnvs();
    resetConfigForTests();
  });
});

describe("excepții", () => {
  it("asset-urile statice trec fără JWT; restul nu", async () => {
    const p = policy();
    expect(await isRequestAllowed(req("/_next/static/chunks/app.js"), p)).toBe(true);
    for (const path of [
      "/",
      "/_next/image",
      "/_next/data/x.json",
      "/favicon.ico",
      "/favicon.ico.bak",
      "/_next/staticx",
      "/api/health",
    ]) {
      expect(await isRequestAllowed(req(path), p)).toBe(false);
    }
  });

  it("isLocalProbe: doar Host loopback, fără antete de proxy", () => {
    const probe = (h: Record<string, string>) => isLocalProbe(new Headers(h));
    expect(probe({ host: "127.0.0.1:3000" })).toBe(true);
    expect(probe({ host: "localhost:3000", "x-forwarded-for": "127.0.0.1" })).toBe(true);
    expect(
      probe({ host: "[::1]:3000", "x-forwarded-for": "::1", "x-forwarded-host": "[::1]:3000" }),
    ).toBe(true);
    expect(probe({})).toBe(false);
    expect(probe({ host: "finet.exemplu.invalid" })).toBe(false);
    expect(probe({ host: "127.0.0.1.exemplu.invalid" })).toBe(false);
    expect(probe({ host: "127.0.0.1", "cf-connecting-ip": "203.0.113.5" })).toBe(false);
    expect(probe({ host: "127.0.0.1", "cf-ray": "abc" })).toBe(false);
    expect(probe({ host: "127.0.0.1", "x-real-ip": "203.0.113.5" })).toBe(false);
    expect(probe({ host: "127.0.0.1", "x-forwarded-for": "203.0.113.5" })).toBe(false);
    expect(probe({ host: "127.0.0.1", "x-forwarded-for": "127.0.0.1, 203.0.113.5" })).toBe(false);
    expect(probe({ host: "127.0.0.1", "x-forwarded-host": "finet.exemplu.invalid" })).toBe(false);
  });

  it("liveness local nu deschide alte căi", async () => {
    const local = { host: "127.0.0.1:3000" };
    expect(await isRequestAllowed(req("/api/health/live", local), policy())).toBe(true);
    expect(await isRequestAllowed(req("/api/health/live", local, "HEAD"), policy())).toBe(false);
    expect(await isRequestAllowed(req("/api/health/live", local, "POST"), policy())).toBe(false);
    expect(await isRequestAllowed(req("/api/health/live", local, "get"), policy())).toBe(false);
    expect(await isRequestAllowed(req("/api/health/live/", local), policy())).toBe(false);
    expect(await isRequestAllowed(req("/api/health", local), policy())).toBe(false);
    expect(await isRequestAllowed(req("/", local), policy())).toBe(false);
  });

  it("HEALTH_TOKEN: comparație corectă; neconfigurat → nimic nu trece", async () => {
    expect(healthTokenMatches(HEALTH_TOKEN, HEALTH_TOKEN)).toBe(true);
    expect(healthTokenMatches(HEALTH_TOKEN + "x", HEALTH_TOKEN)).toBe(false);
    expect(healthTokenMatches(null, HEALTH_TOKEN)).toBe(false);
    expect(healthTokenMatches("", null)).toBe(false);
    expect(healthTokenMatches(HEALTH_TOKEN, null)).toBe(false);
    const h = { [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN };
    expect(
      await isRequestAllowed(req("/api/health", h), policy({ healthToken: HEALTH_TOKEN })),
    ).toBe(true);
    expect(await isRequestAllowed(req("/api/health", h), policy())).toBe(false);
  });

  it("Access neobligatoriu (dezvoltare) → permis fără JWT", async () => {
    expect(await isRequestAllowed(req("/"), policy({ required: false, verify: null }))).toBe(true);
  });
});

describe("matcher-ul din src/proxy.ts", () => {
  const matches = (url: string) =>
    unstable_doesMiddlewareMatch({
      config: proxyConfig,
      url: `https://finet.exemplu.invalid${url}`,
    });

  it("exclude doar /_next/static/**", () => {
    expect(matches("/_next/static/chunks/app.js")).toBe(false);
    expect(matches("/_next/static/css/x.css")).toBe(false);
  });

  it("acoperă orice altceva", () => {
    for (const path of [
      "/",
      "/api/health",
      "/api/health/live",
      "/api/v1/accounts",
      "/_next/image?url=x",
      "/_next/data/build/x.json",
      "/favicon.ico",
      "/favicon.ico.bak",
      "/_next/staticx",
      "/robots.txt",
      // Faza 6: doar `/api/v1/documents` exact e exclus; tot restul trece prin proxy.
      "/api/v1/documents/",
      "/api/v1/documents/7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f",
      "/api/v1/documents/7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f/file",
      "/api/v1/documentsX",
      "/api/v1/documents.json",
      "/api/v1/documents%2Fx",
      "/api/v1/Documents",
      "/api/v1/receipts",
      // Faza 7: doar `/api/v1/statements/uploads` exact e exclus.
      "/api/v1/statements/uploads/",
      "/api/v1/statements/uploads/7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f",
      "/api/v1/statements/uploadsX",
      "/api/v1/statements/imports",
      "/api/v1/statements/coverage",
      "/api/v1/Statements/uploads",
      "/import",
      "/receipts",
      // Faza 9: fișierele PWA trec prin proxy (Access + antete), ca orice altă cale.
      "/sw.js",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/offline",
      "/pwa/offline.js",
      "/api/v1/app/android/latest",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("exclude exact /api/v1/documents (încărcarea în flux; verificarea Access e în rută)", () => {
    expect(matches("/api/v1/documents")).toBe(false);
    expect(matches("/api/v1/documents?cursor=abc")).toBe(false);
  });

  it("exclude exact /api/v1/statements/uploads (Faza 7; verificarea Access e în rută)", () => {
    expect(matches("/api/v1/statements/uploads")).toBe(false);
    expect(matches("/api/v1/statements/uploads?x=1")).toBe(false);
  });
});

describe("saas public (ADR 0034): isAccessProtectedPath și politica", () => {
  it("rămân sub Access: administrarea și starea, oricum ar fi scrisă adresa", () => {
    for (const path of [
      "/admin",
      "/admin/",
      "/admin/users",
      "/Admin",
      "/ADMIN/x",
      "//admin",
      "/\\admin",
      "/%61dmin",
      "/%41dmin/users",
      "/api/v1/admin",
      "/api/v1/admin/users",
      "/API/V1/ADMIN/users",
      "/api/v1//admin/users",
      "/api/%76%31/admin/users",
      "/api/health",
      "/api/health/live",
      "/api/HEALTH",
      "/foo/../admin",
      "/a/%2e%2e/b",
      "/%E0%A4%A",
      "relativ",
    ]) {
      expect(isAccessProtectedPath(path), path).toBe(true);
    }
  });

  it("sunt publice (nu cer Access) căile site-ului și ale aplicației", () => {
    for (const path of [
      "/",
      "/pricing",
      "/terms",
      "/privacy",
      "/support",
      "/register",
      "/login",
      "/dashboard",
      "/api/auth/sign-in/email",
      "/api/v1/register",
      "/api/v1/me",
      "/api/v1/documents",
      "/manifest.webmanifest",
    ]) {
      expect(isAccessProtectedPath(path), path).toBe(false);
    }
  });

  it("fără publicSaas nimic nu se schimbă: fără JWT → refuzat, inclusiv pe căi publice", async () => {
    expect(await isRequestAllowed(req("/support"), policy())).toBe(false);
    expect(await isRequestAllowed(req("/support"), policy({ publicSaas: false }))).toBe(false);
  });

  it("cu publicSaas: căile publice trec fără JWT; /admin și sănătatea cer JWT valid", async () => {
    const p = policy({ publicSaas: true });
    expect(await isRequestAllowed(req("/support"), p)).toBe(true);
    expect(await isRequestAllowed(req("/api/v1/me"), p)).toBe(true);
    for (const path of ["/admin", "/api/v1/admin/users", "/api/health", "/api/health/live"]) {
      expect(await isRequestAllowed(req(path), p), path).toBe(false);
      expect(await isRequestAllowed(req(path, { [ACCESS_JWT_HEADER]: "a.b.c" }), p), path).toBe(
        false,
      );
      expect(
        await isRequestAllowed(req(path, { [ACCESS_JWT_HEADER]: await token() }), p),
        path,
      ).toBe(true);
    }
  });

  it("cu publicSaas, JWT cu cheie străină sau audiență greșită tot nu deschide /admin", async () => {
    const p = policy({ publicSaas: true });
    const foreign = await token({}, otherPrivateKey);
    expect(await isRequestAllowed(req("/admin", { [ACCESS_JWT_HEADER]: foreign }), p)).toBe(false);
    const wrongAud = await token({ aud: "alta" });
    expect(await isRequestAllowed(req("/admin", { [ACCESS_JWT_HEADER]: wrongAud }), p)).toBe(false);
  });

  it("tokenul de sănătate deschide doar /api/health (nu /admin), ca înainte", async () => {
    const p = policy({ publicSaas: true, healthToken: HEALTH_TOKEN });
    const h = { [HEALTH_TOKEN_HEADER]: HEALTH_TOKEN };
    expect(await isRequestAllowed(req("/api/health", h), p)).toBe(true);
    expect(await isRequestAllowed(req("/admin", h), p)).toBe(false);
  });

  describe("proxy() cu mediul de producție `saas`", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      resetConfigForTests();
    });

    function saasEnv(extra: Record<string, string> = {}) {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("APP_MODE", "saas");
      vi.stubEnv("STORAGE_DIR", "/tmp/finet-nu-se-foloseste");
      vi.stubEnv("APP_URL", "https://finet.exemplu.invalid");
      vi.stubEnv("BETTER_AUTH_SECRET", "secret-fictiv-de-test-0123456789abcdef");
      // Domeniu `.invalid`: JWKS-ul nu poate fi obținut niciodată (un JWT nu poate fi verificat).
      vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", "echipa.invalid");
      vi.stubEnv("CF_ACCESS_AUD", AUD);
      vi.stubEnv("CF_ACCESS_REQUIRED", "");
      vi.stubEnv("HEALTH_TOKEN", "");
      vi.stubEnv("SAAS_PUBLIC_ACCESS", "");
      vi.stubEnv("TRUST_CF_CONNECTING_IP", "");
      vi.stubEnv("FINET_ROLE", "");
      vi.stubEnv("WORKER_DATABASE_URL", "");
      vi.stubEnv("MIGRATOR_DATABASE_URL", "");
      for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
      resetConfigForTests();
    }

    const call = (path: string, headers: Record<string, string> = {}) =>
      proxy(new NextRequest(`https://finet.exemplu.invalid${path}`, { headers }));

    const PRIVATE_PATHS = ["/admin", "/admin/", "/Admin", "//admin", "/%61dmin"];

    it("fără SAAS_PUBLIC_ACCESS: 403 pe orice cale, exact ca până acum", async () => {
      saasEnv();
      for (const path of ["/", "/support", "/register", "/login", "/api/v1/me", "/api/auth/x"]) {
        expect((await call(path)).status, path).toBe(403);
      }
      for (const path of [...PRIVATE_PATHS, "/api/v1/admin/users", "/api/health"]) {
        expect((await call(path)).status, path).toBe(403);
      }
    });

    it("cu SAAS_PUBLIC_ACCESS=true: căile publice și aplicația trec; sesiunea rămâne bariera lor", async () => {
      saasEnv({ SAAS_PUBLIC_ACCESS: "true" });
      for (const path of ["/", "/support", "/register", "/login", "/api/v1/me", "/api/auth/x"]) {
        const res = await call(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("x-middleware-next"), path).toBe("1");
        expect(res.headers.get("content-security-policy"), path).toContain(
          "frame-ancestors 'none'",
        );
      }
    });

    it("cu SAAS_PUBLIC_ACCESS=true: /admin, /api/v1/admin/* și sănătatea rămân 403 fără JWT valid", async () => {
      saasEnv({ SAAS_PUBLIC_ACCESS: "true" });
      for (const path of [
        ...PRIVATE_PATHS,
        "/api/v1/admin/users",
        "/api/v1/admin",
        "/API/V1/admin/users",
        "/api/health",
        "/api/health/live",
      ]) {
        const res = await call(path);
        expect(res.status, path).toBe(403);
        expect(res.headers.get("x-middleware-next"), path).toBeNull();
      }
      // Un JWT fals sau nesemnat nu deschide nimic.
      expect((await call("/admin", { [ACCESS_JWT_HEADER]: "a.b.c" })).status).toBe(403);
    });

    it("FAIL-CLOSED: SAAS_PUBLIC_ACCESS=true în `personal` (configurație invalidă) → 403 pe tot", async () => {
      saasEnv({ APP_MODE: "personal", SAAS_PUBLIC_ACCESS: "true" });
      for (const path of ["/", "/support", "/register", "/api/v1/me"]) {
        expect((await call(path)).status, path).toBe(403);
      }
    });
  });
});
