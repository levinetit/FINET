import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { createHousehold } from "@/db/households";
import { TEST_ADMIN_URL } from "@/db/testing";
import type { Actor } from "@/lib/authz";
import { createAccount } from "@/modules/accounts/accounts.service";
import { hashPassword } from "@/modules/auth/password";
import { leaveHousehold } from "@/modules/family/members.service";
import { createSettlement } from "@/modules/family/settlements.service";
import { setTransactionSplit } from "@/modules/family/splits.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { sqlState } from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import {
  AccountDeletionError,
  FRESH_SESSION_MINUTES,
  deleteAccount,
  previewAccountDeletion,
} from "./account-deletion";
import { MemoryStorage } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const PASSWORD = "parola-de-test-lunga-123";

describe.skipIf(!TEST_ADMIN_URL)("ștergerea contului (Postgres real, finet_app)", () => {
  let f: FamilyFixture;
  let passwordHash: string;
  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_gdpr_del");
    passwordHash = await hashPassword(PASSWORD);
  });
  afterAll(async () => {
    await f?.close();
  });

  const deps = () => ({ db: f.db });

  async function user(name: string, withPassword = true): Promise<Actor & { sessionId: string }> {
    const u = await f.newUser(name);
    if (withPassword) {
      await f.admin`insert into finet.auth_accounts (account_id, provider_id, user_id, password)
        values (${u.userId}, 'credential', ${u.userId}, ${passwordHash})`;
    }
    await f.admin`insert into finet.user_preferences (user_id) values (${u.userId})`;
    const [s] = await f.admin<{ id: string }[]>`
      insert into finet.auth_sessions (expires_at, token, user_id)
      values (now() + interval '1 day', ${randomBytes(16).toString("hex")}, ${u.userId})
      returning id`;
    return { ...u, sessionId: s!.id };
  }

  async function household(owner: Actor, name: string): Promise<string> {
    return withRlsOn(f.db, { userId: owner.userId }, (tx) => createHousehold(tx, { name }));
  }

  async function account(actor: Actor, hh: string, personal: boolean, name: string) {
    return createAccount(deps(), actor, hh, {
      name,
      type: "cash",
      currency: "RON",
      ...(personal ? { ownerUserId: actor.userId } : {}),
    });
  }

  async function expense(actor: Actor, hh: string, accountId: string, amountMinor: number) {
    return createTransaction(deps(), actor, hh, {
      accountId,
      type: "expense",
      amountMinor,
      occurredOn: "2026-10-10",
      description: "Descriere secretă",
    });
  }

  async function documentWithFile(storage: MemoryStorage, actor: Actor, hh: string) {
    const id = randomUUID();
    const key = `households/${hh}/documents/${id}`;
    const sha = createHash("sha256").update(id).digest("hex");
    await f.admin`insert into finet.documents (id, household_id, uploaded_by_user_id, status,
        storage_key, detected_mime, size_bytes, sha256)
      values (${id}, ${hh}, ${actor.userId}, 'awaiting_consent', ${key}, 'image/jpeg', 3, ${sha})`;
    storage.seed(key, new Uint8Array([1, 2, 3]));
    return { id, key };
  }

  const del = (storage: MemoryStorage, u: Actor & { sessionId: string }, password = PASSWORD) =>
    deleteAccount({ db: f.db, storage }, u, { password, confirm: "ȘTERGE" });

  async function userRow(id: string) {
    const [row] = await f.admin<{ name: string; email: string; status: string }[]>`
      select name, email, status from finet.users where id = ${id}`;
    return row ?? null;
  }

  it("previzualizarea: gospodăria proprie se șterge, cea cu alt owner se părăsește, ultimul owner blochează", async () => {
    const a = await user("PrevA");
    const b = await user("PrevB");
    const c = await user("PrevC");
    const own = await household(a, "Doar A");
    const shared = await household(b, "Comună B");
    await f.addMember(b, shared, a, "owner");
    const led = await household(a, "Condusă de A");
    await f.addMember(a, led, c);
    const p = await previewAccountDeletion(f.db, a.userId);
    expect(p.hasPassword).toBe(true);
    // Gospodăria personală creată de fixture nu există pentru utilizatorii noi: doar acestea trei.
    expect(p.deletedHouseholds.map((h) => h.id)).toEqual([own]);
    expect(p.leftHouseholds).toEqual([{ id: shared, name: "Comună B", unsettled: false }]);
    expect(p.blockedHouseholds).toEqual([{ id: led, name: "Condusă de A" }]);
    // Fără sume sau descrieri în previzualizare.
    expect(JSON.stringify(p)).not.toMatch(/Minor|amount|descri/i);
  });

  it("parola greșită sau lipsă → invalid_password; nimic nu se schimbă", async () => {
    const a = await user("ParolaA");
    await household(a, "Casa ParolaA");
    const storage = new MemoryStorage();
    await expect(del(storage, a, "gresita-gresita")).rejects.toMatchObject({
      code: "invalid_password",
    });
    await expect(
      deleteAccount({ db: f.db, storage }, a, { confirm: "ȘTERGE" }),
    ).rejects.toBeInstanceOf(AccountDeletionError);
    expect((await userRow(a.userId))?.status).toBe("active");
  });

  it("fără parolă (magic link): doar cu o sesiune proaspătă", async () => {
    const a = await user("MagicA", false);
    await household(a, "Casa MagicA");
    const storage = new MemoryStorage();
    const old = () => new Date(Date.now() + (FRESH_SESSION_MINUTES + 1) * 60_000);
    await expect(
      deleteAccount({ db: f.db, storage, now: old }, a, { confirm: "ȘTERGE" }),
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect((await deleteAccount({ db: f.db, storage }, a, { confirm: "ȘTERGE" })).outcome).toBe(
      "deleted",
    );
    expect(await userRow(a.userId)).toBeNull();
  });

  it("ultimul owner al unei gospodării cu alți membri: 409 last_owner și NIMIC șters (nici gospodăria proprie)", async () => {
    const a = await user("LastA");
    const c = await user("LastC");
    const own = await household(a, "Proprie LastA");
    const led = await household(a, "Condusă LastA");
    await f.addMember(a, led, c);
    const storage = new MemoryStorage();
    const doc = await documentWithFile(storage, a, own);
    await expect(del(storage, a)).rejects.toMatchObject({ code: "last_owner" });
    expect((await userRow(a.userId))?.status).toBe("active");
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.households where id in (${own}, ${led})`;
    expect(n?.n).toBe(2);
    expect(storage.files.has(doc.key)).toBe(true);
    const [s] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.auth_sessions where user_id = ${a.userId}`;
    expect(s?.n).toBe(1);
  });

  it("singurul membru: gospodăria, datele și fișierele se șterg; rândul users dispare; sesiunile și parola la fel", async () => {
    const a = await user("SoloA");
    const hh = await household(a, "Solo");
    const acc = await account(a, hh, false, "Numerar");
    await expense(a, hh, acc.id, 1234);
    const storage = new MemoryStorage();
    const doc = await documentWithFile(storage, a, hh);
    const other = await documentWithFile(storage, a, f.HB); // altă gospodărie (B), nu se atinge
    await f.admin`insert into finet.consents (user_id, kind) values (${a.userId}, 'usage_stats')`;
    const r = await del(storage, a);
    expect(r).toEqual({ outcome: "deleted", deletedHouseholds: 1, leftHouseholds: 0 });
    expect(storage.files.has(doc.key)).toBe(false);
    expect(storage.files.has(other.key)).toBe(true);
    const counts = await f.admin<{ t: string; n: number }[]>`
      select 'households' as t, count(*)::int as n from finet.households where id = ${hh}
      union all select 'transactions', count(*)::int from finet.transactions where household_id = ${hh}
      union all select 'documents', count(*)::int from finet.documents where household_id = ${hh}
      union all select 'sessions', count(*)::int from finet.auth_sessions where user_id = ${a.userId}
      union all select 'auth', count(*)::int from finet.auth_accounts where user_id = ${a.userId}
      union all select 'consents', count(*)::int from finet.consents where user_id = ${a.userId}
      union all select 'prefs', count(*)::int from finet.user_preferences where user_id = ${a.userId}`;
    expect(counts.every((c) => c.n === 0)).toBe(true);
    expect(await userRow(a.userId)).toBeNull();
  });

  it("gospodăria comună: conturile personale (și cele din gospodării părăsite) se șterg, NU devin comune; transferul personal→comun lasă soldul comun neschimbat; istoricul împărțirilor/decontărilor rămâne sub „Cont șters”", async () => {
    const owner = await user("FamOwner");
    const a = await user("FamA");
    const hh = await household(owner, "Familia Del");
    await f.addMember(owner, hh, a);
    const common = await account(owner, hh, false, "Comun");
    const ownerPersonal = await account(owner, hh, true, "Al ownerului");
    const aPersonal = await account(a, hh, true, "Al lui A");
    // Cheltuială comună împărțită (A participă), plătită de owner din contul lui personal.
    const t1 = await expense(owner, hh, ownerPersonal.id, 10_000);
    await setTransactionSplit(deps(), owner, hh, t1.id, {
      mode: "equal",
      userIds: [owner.userId, a.userId],
    });
    // Cheltuiala lui A din contul personal, împărțită cu owner-ul (owner îi datorează lui A).
    const t2 = await expense(a, hh, aPersonal.id, 4_000);
    await setTransactionSplit(deps(), a, hh, t2.id, {
      mode: "equal",
      userIds: [owner.userId, a.userId],
    });
    await createSettlement(deps(), a, hh, {
      fromUserId: a.userId,
      toUserId: owner.userId,
      amount: "10,00",
      currency: "RON",
      settledOn: "2026-10-11",
    });
    // Transfer personal (A) → comun: 2500.
    await createTransfer(deps(), a, hh, {
      fromAccountId: aPersonal.id,
      toAccountId: common.id,
      amountMinor: 2_500,
      occurredOn: "2026-10-12",
    });
    // O gospodărie părăsită mai demult, cu un cont personal rămas (invizibil pentru toți).
    const old = await household(owner, "Veche");
    await f.addMember(owner, old, a);
    const oldPersonal = await account(a, old, true, "Rămas în Veche");
    await expense(a, old, oldPersonal.id, 777);
    await leaveHousehold(deps(), a, old);

    const balanceOf = async (accountId: string) => {
      const [row] = await f.admin<{ s: string }[]>`
        select coalesce(sum(case when type = 'income' or transfer_direction = 'in' then amount_minor
                                 else -amount_minor end), 0)::text as s
          from finet.transactions where account_id = ${accountId}`;
      return row!.s;
    };
    const commonBefore = await balanceOf(common.id);
    expect(commonBefore).toBe("2500");

    const storage = new MemoryStorage();
    const r = await del(storage, a);
    expect(r).toEqual({ outcome: "anonymized", deletedHouseholds: 0, leftHouseholds: 1 });

    // Conturile personale ale lui A: șterse peste tot (nimic nu a devenit comun).
    const accs = await f.admin<{ id: string; owner_user_id: string | null }[]>`
      select id, owner_user_id from finet.accounts where id in (${aPersonal.id}, ${oldPersonal.id})`;
    expect(accs).toEqual([]);
    const [orphans] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id in (${aPersonal.id}, ${oldPersonal.id})`;
    expect(orphans?.n).toBe(0);
    // Jumătatea comună a transferului a devenit un venit: soldul comun e același.
    expect(await balanceOf(common.id)).toBe(commonBefore);
    const [leg] = await f.admin<{ type: string; transfer_group_id: string | null }[]>`
      select type, transfer_group_id from finet.transactions where account_id = ${common.id}`;
    expect(leg).toEqual({ type: "income", transfer_group_id: null });
    // Contul personal al owner-ului și cheltuiala lui rămân, cu împărțirea în care A apare.
    const [kept] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transaction_splits where transaction_id = ${t1.id}`;
    expect(kept?.n).toBe(2);
    // Împărțirea cheltuielii personale a lui A a dispărut odată cu ea.
    const [gone] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transaction_splits where transaction_id = ${t2.id}`;
    expect(gone?.n).toBe(0);
    const [st] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.settlements where from_user_id = ${a.userId}`;
    expect(st?.n).toBe(1);
    // Rândul anonimizat: fără nume/email real, dezactivat, fără sesiuni, parolă sau apartenențe.
    const row = await userRow(a.userId);
    expect(row).toEqual({
      name: "Cont șters",
      email: `deleted-${a.userId}@deleted.invalid`,
      status: "disabled",
    });
    const [rest] = await f.admin<{ n: number }[]>`
      select (select count(*) from finet.household_members where user_id = ${a.userId})
           + (select count(*) from finet.auth_sessions where user_id = ${a.userId})
           + (select count(*) from finet.auth_accounts where user_id = ${a.userId})
           + (select count(*) from finet.user_preferences where user_id = ${a.userId})
           + (select count(*) from finet.budgets where user_id = ${a.userId}) as n`;
    expect(Number(rest?.n)).toBe(0);
    // Plecarea e auditată fără conținut.
    const [audit] = await f.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events
       where household_id = ${hh} and action = 'household.member_left' and target_id = ${a.userId}`;
    expect(audit?.metadata).toEqual({ accountDeleted: true, unsettled: true });
    // Owner-ul vede în continuare doar contul comun + al lui; tranzacția lui personală e întreagă.
    const visible = await withRlsOn(f.db, { userId: owner.userId, householdId: hh }, (tx) =>
      tx.execute<{ id: string }>(sql`select id from finet.accounts order by name`),
    );
    expect(visible.map((x) => x.id).sort()).toEqual([common.id, ownerPersonal.id].sort());
  });

  it("administratorul platformei: refuz 409 platform_admin, nimic șters; garda și în bază (42501)", async () => {
    const a = await user("AdminDel");
    await household(a, "Casa AdminDel");
    await f.admin`update finet.users set is_platform_admin = true where id = ${a.userId}`;
    const storage = new MemoryStorage();
    expect((await previewAccountDeletion(f.db, a.userId)).platformAdmin).toBe(true);
    await expect(del(storage, a)).rejects.toMatchObject({ code: "platform_admin" });
    expect((await userRow(a.userId))?.status).toBe("active");
    await f.admin`delete from finet.household_members where user_id = ${a.userId}`;
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: a.userId }, (tx) =>
          tx.execute(sql`select finet.erase_current_user()`),
        ),
      ),
    ).toBe("42501");
  });

  it("finet.erase_current_user: refuzată cât e încă membru (42501); pentru un utilizator inexistent întoarce not_found (idempotent)", async () => {
    const a = await user("EraseGuard");
    await household(a, "Casa EraseGuard");
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: a.userId }, (tx) =>
          tx.execute(sql`select finet.erase_current_user()`),
        ),
      ),
    ).toBe("42501");
    const ghost = randomUUID();
    const rows = await withRlsOn(f.db, { userId: ghost }, (tx) =>
      tx.execute<{ r: string }>(sql`select finet.erase_current_user() as r`),
    );
    expect(rows[0]?.r).toBe("not_found");
    // Fără context: refuzată.
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: null }, (tx) =>
          tx.execute(sql`select finet.erase_current_user()`),
        ),
      ),
    ).toBe("42501");
  });

  it("o eroare la ștergerea fișierelor după commit nu readuce datele (doar contorizată)", async () => {
    const a = await user("FileFail");
    const hh = await household(a, "Casa FileFail");
    const storage = new MemoryStorage();
    const doc = await documentWithFile(storage, a, hh);
    storage.failDelete.add(doc.key);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect((await del(storage, a)).outcome).toBe("deleted");
      const logged = info.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("eșuate=1");
      expect(logged).not.toContain(a.userId);
      expect(logged).not.toContain(doc.key);
    } finally {
      info.mockRestore();
    }
  });
});
