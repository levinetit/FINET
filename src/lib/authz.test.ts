import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Db, createDb, withRlsOn } from "@/db";
import { createHousehold } from "@/db/households";
import { runMigrations } from "@/db/migrate";
import { auditEvents, householdMembers } from "@/db/schema";
import {
  MIGRATIONS_DIR,
  type ScratchDatabase,
  TEST_ADMIN_URL,
  createScratchDatabase,
  testClient,
} from "@/db/testing";

import { ForbiddenError, NotFoundError, requireMember, roleAtLeast, withMember } from "./authz";

describe("ierarhia rolurilor", () => {
  it("member < owner", () => {
    expect(roleAtLeast("owner", "member")).toBe(true);
    expect(roleAtLeast("owner", "owner")).toBe(true);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("member", "owner")).toBe(false);
  });

  it("erorile au codurile și statusurile HTTP din 6.4, fără detalii", () => {
    expect(new NotFoundError()).toMatchObject({ code: "not_found", status: 404 });
    expect(new ForbiddenError()).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("un id invalid dă NotFound fără să atingă baza", async () => {
    const noDb = new Proxy({} as Db, {
      get() {
        throw new Error("baza nu trebuia atinsă");
      },
    });
    await expect(
      requireMember({ userId: randomUUID() }, "nu-e-uuid", "member", { db: noDb }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requireMember({ userId: "x" }, randomUUID(), "member", { db: noDb }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("requireMember pe PostgreSQL real", () => {
  let scratch: ScratchDatabase;
  let app: { db: Db; client: postgres.Sql };
  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  let HA: string;
  let HB: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase("finet_it_authz");
    const migrator = testClient(scratch.migratorUrl, 1);
    try {
      await runMigrations(migrator, { folder: MIGRATIONS_DIR });
    } finally {
      await migrator.end({ timeout: 5 });
    }
    app = createDb(scratch.appUrl, { ca: null, applicationName: "finet-test", max: 2 });
    for (const [id, email] of [
      [A, "a@exemplu.ro"],
      [B, "b@exemplu.ro"],
      [C, "c@exemplu.ro"],
    ] as const) {
      // Listă explicită de coloane: `finet_app` are INSERT doar pe ele (M5).
      await app.db.execute(
        sql`insert into finet.users (id, email, name) values (${id}, ${email}, ${email})`,
      );
    }
    HA = await withRlsOn(app.db, { userId: A }, (tx) => createHousehold(tx, { name: "Casa A" }));
    HB = await withRlsOn(app.db, { userId: B }, (tx) => createHousehold(tx, { name: "Casa B" }));
    await withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
      tx.insert(householdMembers).values({ householdId: HA, userId: C, role: "member" }),
    );
  });

  afterAll(async () => {
    await app?.client.end({ timeout: 5 });
    await scratch?.drop();
  });

  const opts = () => ({ db: app.db });

  it("owner și member în propria gospodărie", async () => {
    await expect(requireMember({ userId: A }, HA, "owner", opts())).resolves.toEqual({
      householdId: HA,
      userId: A,
      role: "owner",
    });
    await expect(requireMember({ userId: C }, HA, "member", opts())).resolves.toMatchObject({
      role: "member",
    });
    // Uuid-ul cu majuscule e același id.
    await expect(
      requireMember({ userId: A }, HA.toUpperCase(), "member", opts()),
    ).resolves.toMatchObject({
      householdId: HA,
    });
  });

  it("gospodăria altcuiva și una inexistentă dau ACELAȘI NotFound", async () => {
    const foreign = await requireMember({ userId: A }, HB, "member", opts()).catch(
      (e: unknown) => e,
    );
    const missing = await requireMember({ userId: A }, randomUUID(), "member", opts()).catch(
      (e: unknown) => e,
    );
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((foreign as Error).message).toBe((missing as Error).message);
  });

  it("member cu minRole owner → Forbidden", async () => {
    await expect(requireMember({ userId: C }, HA, "owner", opts())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("withMember rulează în contextul RLS al gospodăriei verificate", async () => {
    const seen = await withMember(
      { userId: A },
      HA,
      "member",
      async (tx, m) => {
        expect(m.role).toBe("owner");
        await tx
          .insert(auditEvents)
          .values({ householdId: HA, actorUserId: A, action: "member.checked" });
        return tx.select({ householdId: auditEvents.householdId }).from(auditEvents);
      },
      opts(),
    );
    expect(seen).toEqual([{ householdId: HA }]);
  });

  it("withMember nu rulează fn dacă verificarea eșuează", async () => {
    let ran = false;
    await expect(
      withMember(
        { userId: C },
        HB,
        "member",
        async () => {
          ran = true;
        },
        opts(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(ran).toBe(false);
  });
});
