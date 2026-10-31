import { beforeEach, describe, expect, it, vi } from "vitest";

import { testConfig } from "@/modules/auth/testing";

const state = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/lib/config", async (original) => ({
  ...(await original<typeof import("@/lib/config")>()),
  getConfig: () => {
    if (!state.config) throw new Error("config ilizibil");
    return state.config;
  },
}));

import { GET } from "./[code]/route";

const call = (code: string) =>
  GET(new Request(`http://intern/ref/${code}`) as never, { params: Promise.resolve({ code }) });

/** `/ref/<cod>` (12-C, ADR 0037): doar `saas`; același răspuns pentru orice formă de cod. */
describe("12-C: ruta /ref/<cod>", () => {
  beforeEach(() => {
    state.config = null;
  });

  it("în personal sau cu config ilizibil: 404, fără cookie", async () => {
    state.config = testConfig({});
    const personal = await call("FIN-AB23CD");
    expect(personal.status).toBe(404);
    expect(personal.headers.get("set-cookie")).toBeNull();
    state.config = null;
    expect((await call("FIN-AB23CD")).status).toBe(404);
  });

  it("în saas: cod valid ca formă → cookie HttpOnly + 303 spre /register", async () => {
    state.config = testConfig({ APP_MODE: "saas" });
    const res = await call("fin-ab23cd");
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/register");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain("finet_ref=FIN-AB23CD");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("în saas: cod invalid → același redirect, fără cookie (nu e un oracol)", async () => {
    state.config = testConfig({ APP_MODE: "saas" });
    for (const bad of ["garbage", "FIN-AB23CO", "x".repeat(300)]) {
      const res = await call(bad);
      expect(res.status, bad).toBe(303);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/register");
      expect(res.headers.get("set-cookie"), bad).toBeNull();
    }
  });
});
