import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";

import { createHousehold } from "./households";
import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** L1: `finet.create_household` are un plafon de 20 de gospodării create per utilizator. */
describe.skipIf(!TEST_ADMIN_URL)("plafonul de gospodării per utilizator (L1)", () => {
  let fx: AuthFixture;
  const U = randomUUID();

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_hhlimit");
    await fx.db.execute(
      sql`insert into finet.users (id, email, name) values (${U}, 'u@exemplu.ro', 'U')`,
    );
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("primele 20 merg, a 21-a dă eroarea 54000 și nu lasă nimic în urmă", async () => {
    for (let i = 1; i <= 20; i++) {
      await withRlsOn(fx.db, { userId: U }, (tx) => createHousehold(tx, { name: `Casa ${i}` }));
    }
    let code: unknown = null;
    try {
      await withRlsOn(fx.db, { userId: U }, (tx) => createHousehold(tx, { name: "Casa 21" }));
    } catch (error) {
      const e = error as { code?: unknown; cause?: { code?: unknown } };
      code = e.cause?.code ?? e.code;
    }
    expect(code).toBe("54000");
    const [row] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.households where created_by = ${U}`;
    expect(row!.n).toBe(20);
  });
});
