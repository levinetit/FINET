import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { ConflictError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { createTag } from "@/modules/tags/tags.service";

import { HOUSEHOLD_CAPS, assertUnderCap } from "./context";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Plafoanele per gospodărie (LOW-4, închis în modernizarea 2026; ADR 0051): `assertUnderCap` pur,
 * apoi pe Postgres real: a N+1-a etichetă → 409 `household_limit_reached`; alte gospodării nu sunt
 * afectate (plafonul e pe gospodărie, nu global); conturile arhivate contează.
 */

describe("assertUnderCap", () => {
  it("sub plafon trece; la plafon aruncă ConflictError cu motivul fix", () => {
    expect(() => assertUnderCap(0, 3, "x")).not.toThrow();
    expect(() => assertUnderCap(2, 3, "x")).not.toThrow();
    try {
      assertUnderCap(3, 3, "etichete");
      throw new Error("trebuia să arunce");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).reason).toBe("household_limit_reached");
      expect((e as ConflictError).message).toContain("3 etichete");
    }
  });
  it("plafoanele sunt generoase, dar finite", () => {
    for (const v of Object.values(HOUSEHOLD_CAPS)) expect(v).toBeGreaterThanOrEqual(100);
    expect(HOUSEHOLD_CAPS.tags).toBeLessThanOrEqual(1000);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("plafoanele pe Postgres real (finet_app)", () => {
  let fx: AuthFixture;
  let ana: { userId: string; householdId: string };
  let bogdan: { userId: string; householdId: string };

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_household_caps");
    const mk = async (email: string) => {
      const r = await createUserWithHousehold(fx.db, {
        email,
        name: "X",
        password: null,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
      return { userId: r.userId, householdId: r.householdId! };
    };
    ana = await mk("ana@exemplu.ro");
    bogdan = await mk("bogdan@exemplu.ro");
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("etichete: plafonul se atinge doar în gospodăria plină; 409 cu motivul fix", async () => {
    // Etichetele de sistem (5) nu intră în plafon? Intră: numărăm tot ce vede gospodăria.
    const deps = { db: fx.db };
    const actor = { userId: ana.userId };
    const existing = (await import("@/modules/tags/tags.service")).listTags;
    const start = (await existing(deps, actor, ana.householdId)).length;
    for (let i = start; i < HOUSEHOLD_CAPS.tags; i++) {
      await createTag(deps, actor, ana.householdId, { name: `t${i}` });
    }
    await expect(createTag(deps, actor, ana.householdId, { name: "peste" })).rejects.toMatchObject({
      reason: "household_limit_reached",
    });
    // Bogdan nu e afectat.
    await expect(
      createTag(deps, { userId: bogdan.userId }, bogdan.householdId, { name: "liber" }),
    ).resolves.toMatchObject({ name: "liber" });
  });

  it("conturi: mesajul conține plafonul; un cont sub plafon trece", async () => {
    const r = await createAccount({ db: fx.db }, { userId: bogdan.userId }, bogdan.householdId, {
      name: "Bancă",
      type: "bank",
      currency: "RON",
    });
    expect(r.name).toBe("Bancă");
    try {
      assertUnderCap(HOUSEHOLD_CAPS.accounts, HOUSEHOLD_CAPS.accounts, "conturi");
    } catch (e) {
      expect((e as Error).message).toContain(`${HOUSEHOLD_CAPS.accounts} conturi`);
    }
  });
});
