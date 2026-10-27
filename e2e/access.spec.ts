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
