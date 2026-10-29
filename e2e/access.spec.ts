import { expect, test } from "@playwright/test";

// Serverul de producție pornit cu CF_ACCESS_REQUIRED=true (proiectul `access` din
// playwright.config.ts). Fără JWT Cloudflare Access valid, totul e refuzat (fail closed).

test("fără JWT Access, pagina principală dă 403", async ({ request }) => {
  const response = await request.get("/", { maxRedirects: 0 });
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: "forbidden", message: "Acces interzis." },
  });
  expect(response.headers()["cache-control"]).toBe("no-store");
});

test("fără JWT Access, /api/health dă 403", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(403);
});

test("un JWT Access invalid e refuzat", async ({ request }) => {
  const response = await request.get("/", {
    headers: { "Cf-Access-Jwt-Assertion": "a.b.c" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});

test("un HEALTH_TOKEN greșit nu deschide /api/health", async ({ request }) => {
  const response = await request.get("/api/health", {
    headers: { "X-Finet-Health-Token": "x".repeat(40) },
  });
  expect(response.status()).toBe(403);
});

test("liveness-ul local răspunde 200 de pe loopback", async ({ request }) => {
  const response = await request.get("/api/health/live");
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe("ok");
});

test("liveness-ul cu antete Cloudflare cere Access", async ({ request }) => {
  const response = await request.get("/api/health/live", {
    headers: { "CF-Connecting-IP": "203.0.113.5" },
  });
  expect(response.status()).toBe(403);
});

test("liveness-ul local acceptă doar GET: HEAD și POST dau 403", async ({ request }) => {
  expect((await request.head("/api/health/live", { maxRedirects: 0 })).status()).toBe(403);
  expect((await request.post("/api/health/live", { maxRedirects: 0 })).status()).toBe(403);
});

test("liveness-ul cu X-Forwarded-For public cere Access", async ({ request }) => {
  const response = await request.get("/api/health/live", {
    headers: { "X-Forwarded-For": "203.0.113.5" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});

test("variantele codificate ale căii de liveness dau 403", async ({ request }) => {
  for (const path of ["/api/health/live%2f", "/api/health/live%2F", "/api/health/%6cive"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(403);
  }
});

test("liveness-ul cu / final: Next redirecționează (308) spre calea exactă, înainte de proxy", async ({
  request,
}) => {
  // Comportament observat (Next 16.4.3): redirecționarea pentru `/` final rulează înaintea
  // `src/proxy.ts`. Ținta e chiar calea de liveness, care trece apoi prin aceleași reguli (GET,
  // loopback), deci nu deschide nimic în plus.
  const response = await request.get("/api/health/live/", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()["location"]).toBe("/api/health/live");
  expect(await response.text()).not.toBe("ok");
  const post = await request.post("/api/health/live/", { maxRedirects: 0 });
  expect(post.status()).toBe(308);
});

// Antetele de securitate pe serverul de producție (6.3): și pe 403, și pe liveness.
function expectProductionHeaders(headers: Record<string, string>) {
  const csp = headers["content-security-policy"] ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toContain(`script-src 'self' 'nonce-${nonce}';`);
  expect(csp).toContain(`style-src 'self' 'nonce-${nonce}';`);
  expect(csp).not.toMatch(/unsafe-|strict-dynamic/);
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
    expect(csp).toContain(directive);
  }
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=()");
  expect(Object.keys(headers).filter((h) => h.startsWith("access-control-allow-"))).toEqual([]);
  return nonce!;
}

test("antetele de securitate pe 403 și pe liveness; nonce nou la fiecare cerere", async ({
  request,
}) => {
  const login = await request.get("/login", { maxRedirects: 0 });
  expect(login.status()).toBe(403);
  const first = expectProductionHeaders(login.headers());
  const live = await request.get("/api/health/live");
  expect(live.status()).toBe(200);
  const second = expectProductionHeaders(live.headers());
  expect(second).not.toBe(first);
});

test("CORS închis: un preflight din altă origine nu primește Access-Control-Allow-*", async ({
  request,
}) => {
  const response = await request.fetch("/api/v1/me", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PATCH" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
  expect(Object.keys(response.headers()).filter((h) => h.startsWith("access-control-"))).toEqual(
    [],
  );
});

// Faza 6 (ADR 0015): `/api/v1/documents` e EXCLUSĂ din matcher-ul proxy-ului (încărcarea în flux),
// dar ruta refăce aceeași verificare Access: fără JWT, 403 înainte de sesiune și de corp, pe
// toate metodele; sub-căile trec în continuare prin proxy.
test("fără JWT Access, încărcarea și lista documentelor dau 403 (ruta exclusă din proxy)", async ({
  request,
}) => {
  const post = await request.post("/api/v1/documents", {
    multipart: { files: { name: "bon.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(16) } },
    maxRedirects: 0,
  });
  expect(post.status()).toBe(403);
  expect(await post.json()).toEqual({ error: { code: "forbidden", message: "Acces interzis." } });
  expect(post.headers()["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
  expect((await request.get("/api/v1/documents", { maxRedirects: 0 })).status()).toBe(403);
  expect((await request.head("/api/v1/documents", { maxRedirects: 0 })).status()).toBe(403);
  expect(
    (await request.fetch("/api/v1/documents", { method: "OPTIONS", maxRedirects: 0 })).status(),
  ).toBe(403);
  const bad = await request.post("/api/v1/documents", {
    headers: { "Cf-Access-Jwt-Assertion": "a.b.c" },
    multipart: { files: { name: "bon.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(16) } },
    maxRedirects: 0,
  });
  expect(bad.status()).toBe(403);
  for (const path of [
    "/api/v1/documents/7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f",
    "/api/v1/documents/7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f/file",
    "/api/v1/receipts",
    "/import",
    "/receipts",
  ]) {
    expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(403);
  }
});

test("Faza 9: fișierele PWA și ruta Android cer Access (403 fără JWT, fără conținut)", async ({
  request,
}) => {
  for (const path of [
    "/sw.js",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/apple-touch-icon.png",
    "/offline",
    "/pwa/offline.js",
    "/help",
    "/settings/android",
    "/api/v1/app/android/latest",
    // F9-B (ADR 0021): GDPR și statistici.
    "/settings/privacy",
    "/settings/statistics",
    "/api/v1/me/export",
    "/api/v1/me/deletion",
    "/api/v1/admin/stats",
  ]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Acces interzis." },
    });
  }
});
