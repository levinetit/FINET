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
