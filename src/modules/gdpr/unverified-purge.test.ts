import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";

import { MemoryStorage } from "./testing";
import { listStaleUnverifiedUsers, purgeUnverifiedAccounts } from "./unverified-purge";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Curățarea conturilor de înregistrare publică neconfirmate (0021; SECURITY_CHECKLIST §36), pe
 * Postgres real: se șterg DOAR conturile vechi, neverificate, fără parolă/sesiune/gospodărie
 * comună; un cont proaspăt, verificat, cu parolă, cu sesiune, administrator sau dezactivat rămâne.
 */
describe.skipIf(!TEST_ADMIN_URL)("curățarea conturilor neconfirmate (Postgres real)", () => {
  let f: FamilyFixture;
  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_purge_unverified");
  });
  afterAll(async () => {
    await f?.close();
  });

  const deps = () => ({ db: f.db, storage: new MemoryStorage() });
  const email = () => `reg-${randomUUID().slice(0, 8)}@exemplu.ro`;

  /** Un cont creat ca la pasul 1 al înregistrării (neverificat, fără parolă), vechi de `ageDays`. */
  async function registered(ageDays: number): Promise<string> {
    const r = await createUserWithHousehold(f.db, {
      email: email(),
      name: "Ana",
      password: null,
      firstUserBecomesAdmin: false,
      emailVerified: false,
    });
    if (!r.created) throw new Error("cont neașteptat");
    await f.admin`update finet.users set created_at = now() - make_interval(days => ${ageDays})
      where id = ${r.userId}`;
    return r.userId;
  }

  const exists = async (id: string) =>
    (await f.admin`select count(*)::int as n from finet.users where id = ${id}`)[0]!.n === 1;
  const households = async (id: string) =>
    (
      await f.admin`select count(*)::int as n from finet.household_members where user_id = ${id}`
    )[0]!.n;

  it("lista conține doar conturile vechi, neverificate, fără parolă/sesiune/gospodărie comună", async () => {
    const stale = await registered(10);
    const fresh = await registered(1);
    const verified = await registered(10);
    await f.admin`update finet.users set email_verified = true where id = ${verified}`;
    const withPassword = await registered(10);
    await f.admin`insert into finet.auth_accounts (account_id, provider_id, user_id, password)
      values (${withPassword}, 'credential', ${withPassword}, 'hash')`;
    const withSession = await registered(10);
    await f.admin`insert into finet.auth_sessions (expires_at, token, user_id)
      values (now() + interval '1 day', ${randomBytes(16).toString("hex")}, ${withSession})`;
    const disabled = await registered(10);
    await f.admin`update finet.users set status = 'disabled' where id = ${disabled}`;
    const admin = await registered(10);
    await f.admin`update finet.users set is_platform_admin = true where id = ${admin}`;
    const shared = await registered(10);
    const [hh] = await f.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${shared}`;
    const other = await f.newUser("Alt");
    await f.addMember({ userId: shared }, hh!.household_id, other);

    const ids = await listStaleUnverifiedUsers(f.db, 7, 500);
    expect(ids).toContain(stale);
    for (const keep of [fresh, verified, withPassword, withSession, disabled, admin, shared]) {
      expect(ids).not.toContain(keep);
    }
    // Pragul de zile și plafonul sunt respectate.
    expect(await listStaleUnverifiedUsers(f.db, 30, 500)).not.toContain(stale);
    expect(await listStaleUnverifiedUsers(f.db, 7, 0)).toEqual([]);
  });

  it("dry-run: numără, dar nu șterge nimic", async () => {
    const id = await registered(20);
    const before = await households(id);
    expect(before).toBe(1);
    const r = await purgeUnverifiedAccounts(deps(), { apply: false });
    expect(r.found).toBeGreaterThanOrEqual(1);
    expect(r.purged).toBe(0);
    expect(await exists(id)).toBe(true);
    expect(await households(id)).toBe(before);
  });

  it("apply: șterge contul și gospodăria personală, păstrează restul; a doua rulare nu mai găsește nimic", async () => {
    const stale = await registered(20);
    const fresh = await registered(1);
    const [hh] = await f.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${stale}`;
    const r = await purgeUnverifiedAccounts(deps(), { apply: true });
    expect(r.failed).toBe(0);
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await exists(stale)).toBe(false);
    expect(
      (
        await f.admin`select count(*)::int as n from finet.households where id = ${hh!.household_id}`
      )[0]!.n,
    ).toBe(0);
    expect(await exists(fresh)).toBe(true);
    const again = await purgeUnverifiedAccounts(deps(), { apply: true });
    expect(again).toEqual({ found: 0, purged: 0, failed: 0 });
  });

  it("finet_app nu poate șterge direct alt utilizator (funcția doar listează)", async () => {
    const id = await registered(20);
    await expect(f.db.execute(sql`delete from finet.users where id = ${id}`)).rejects.toBeDefined();
    expect(await exists(id)).toBe(true);
  });
});
