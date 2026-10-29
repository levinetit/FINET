import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { createHousehold } from "@/db/households";
import { TEST_ADMIN_URL } from "@/db/testing";
import { type Actor, ForbiddenError, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import { resetCleanupForTests } from "@/modules/auth/rate-limit";
import { sqlState } from "@/modules/ledger/testing";
import {
  createTransaction,
  deleteTransaction,
  updateTransaction,
} from "@/modules/transactions/transactions.service";

import { balancesToJson, splitToJson } from "./family.schema";
import {
  InviteRateLimitedError,
  InviteUnavailableError,
  acceptInvite,
  createInvite,
  hashInviteToken,
  listInvites,
  revokeInvite,
} from "./invites.service";
import {
  changeMemberRole,
  leaveHousehold,
  listMembers,
  removeMember,
  setActiveHousehold,
  transferOwnership,
} from "./members.service";
import {
  cancelSettlement,
  createSettlement,
  getBalances,
  listSettlements,
} from "./settlements.service";
import {
  clearTransactionSplit,
  getTransactionSplit,
  listSplits,
  setTransactionSplit,
} from "./splits.service";
import { type FamilyFixture, createFamilyFixture } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe.skipIf(!TEST_ADMIN_URL)("familia (Postgres real, finet_app)", () => {
  let f: FamilyFixture;
  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_fam");
  });
  afterAll(async () => {
    await f?.close();
  });

  const deps = () => ({ db: f.db });
  const acceptDeps = () => ({ db: f.db, acceptLimit: { max: 1000, windowSeconds: 60 } });

  /** O gospodărie nouă: owner + membri (adăugați direct), izolată de celelalte teste. */
  async function family(names: string[]): Promise<{ hh: string; users: Actor[] }> {
    const users: Actor[] = [];
    for (const n of names) users.push(await f.newUser(n));
    const hh = await withRlsOn(f.db, { userId: users[0]!.userId }, (tx) =>
      createHousehold(tx, { name: `Familia ${names[0]}` }),
    );
    for (const u of users.slice(1)) await f.addMember(users[0]!, hh, u);
    return { hh, users };
  }

  async function personalExpense(actor: Actor, hh: string, amountMinor: number, name: string) {
    const acc = await createAccount(deps(), actor, hh, {
      name,
      type: "cash",
      currency: "RON",
      ownerUserId: actor.userId,
    });
    const t = await createTransaction(deps(), actor, hh, {
      accountId: acc.id,
      type: "expense",
      amountMinor,
      occurredOn: "2026-10-10",
    });
    return { accountId: acc.id, transactionId: t.id };
  }

  async function invited(owner: Actor, hh: string, input: unknown = {}) {
    return createInvite(deps(), owner, hh, input);
  }

  // ------------------------------------------------------------------------------------------
  describe("invitații", () => {
    it("owner-ul creează: token 256 biți în clar o singură dată, în bază doar SHA-256", async () => {
      const { hh, users } = await family(["Inv1"]);
      const created = await invited(users[0]!, hh, { role: "member", expiresInHours: 24 });
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(created.token, "base64url")).toHaveLength(32);
      expect(created.invite.status).toBe("active");
      const [row] = await f.admin<{ token_hash: string }[]>`
        select token_hash from finet.household_invites where id = ${created.invite.id}`;
      expect(row?.token_hash).toBe(hashInviteToken(created.token));
      expect(row?.token_hash).not.toContain(created.token);
      // Lista nu conține niciodată tokenul sau hash-ul.
      const list = await listInvites(deps(), users[0]!, hh);
      expect(JSON.stringify(list)).not.toContain(created.token);
      expect(JSON.stringify(list)).not.toContain(row!.token_hash);
    });

    it("valabilitatea maximă (168 h) se acceptă: expirarea e socotită din ceasul bazei", async () => {
      const { hh, users } = await family(["Inv168"]);
      // Ceasul aplicației înaintea bazei nu contează (expirarea o calculează baza).
      const ahead = { db: f.db, now: () => new Date(Date.now() + 60_000) };
      const created = await createInvite(ahead, users[0]!, hh, { expiresInHours: 168 });
      const [row] = await f.admin<{ ok: boolean }[]>`
        select expires_at = created_at + interval '168 hours' as ok
          from finet.household_invites where id = ${created.invite.id}`;
      expect(row?.ok).toBe(true);
    });

    it("acceptarea: intră ca membru, invitația e consumată, gospodăria devine activă", async () => {
      const { hh, users } = await family(["Inv2"]);
      const guest = await f.newUser("Oaspete2");
      const created = await invited(users[0]!, hh);
      expect(await acceptInvite(acceptDeps(), guest, { token: created.token })).toEqual({
        householdId: hh,
        joined: true,
      });
      const members = await listMembers(deps(), guest, hh);
      expect(members.map((m) => [m.userId, m.role])).toEqual([
        [users[0]!.userId, "owner"],
        [guest.userId, "member"],
      ]);
      expect(
        await withRlsOn(f.db, { userId: guest.userId }, (tx) =>
          currentHouseholdIdOf(tx, guest.userId),
        ),
      ).toBe(hh);
      const [inv] = (await listInvites(deps(), users[0]!, hh)).filter(
        (i) => i.id === created.invite.id,
      );
      expect(inv?.status).toBe("used");
      expect(inv?.usedByUserId).toBe(guest.userId);
    });

    it("răspuns uniform pentru token greșit, malformat, expirat, folosit și revocat", async () => {
      const { hh, users } = await family(["Inv3"]);
      const owner = users[0]!;
      const guest = await f.newUser("Oaspete3");
      const other = await f.newUser("Altul3");
      const used = await invited(owner, hh);
      await acceptInvite(acceptDeps(), other, { token: used.token });
      const revoked = await invited(owner, hh);
      await revokeInvite(deps(), owner, hh, revoked.invite.id);
      const expired = await invited(owner, hh, { expiresInHours: 1 });
      await f.admin`update finet.household_invites
                       set created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'
                     where id = ${expired.invite.id}`;
      const wrong = "A".repeat(43);
      const attempts: unknown[] = [
        { token: wrong },
        { token: "scurt" },
        { token: used.token },
        { token: revoked.token },
        { token: expired.token },
        { token: used.token.toLowerCase() === used.token ? wrong : used.token.toLowerCase() },
        {},
        { token: used.token, extra: 1 },
        "nu-e-obiect",
      ];
      const outcomes: string[] = [];
      for (const input of attempts) {
        const error = await acceptInvite(acceptDeps(), guest, input).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InviteUnavailableError);
        const e = error as InviteUnavailableError;
        outcomes.push(`${e.code}|${e.status}|${e.message}`);
      }
      expect(new Set(outcomes)).toEqual(
        new Set(["invite_unavailable|404|Invitația nu mai este valabilă."]),
      );
      // Nimic nu s-a schimbat: oaspetele nu e membru.
      await expect(listMembers(deps(), guest, hh)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("două acceptări concurente ale aceleiași invitații: exact una reușește", async () => {
      const { hh, users } = await family(["Inv4"]);
      const g1 = await f.newUser("Concurent1");
      const g2 = await f.newUser("Concurent2");
      const created = await invited(users[0]!, hh);
      const results = await Promise.allSettled([
        acceptInvite(acceptDeps(), g1, { token: created.token }),
        acceptInvite(acceptDeps(), g2, { token: created.token }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(InviteUnavailableError);
      const [n] = await f.admin<{ n: number }[]>`
        select count(*)::int as n from finet.household_members where household_id = ${hh}`;
      expect(n?.n).toBe(2);
    });

    it("un membru existent nu consumă invitația; rolul `owner` din invitație se aplică", async () => {
      const { hh, users } = await family(["Inv5", "Membru5"]);
      const created = await invited(users[0]!, hh, { role: "owner" });
      expect(await acceptInvite(acceptDeps(), users[1]!, { token: created.token })).toEqual({
        householdId: hh,
        joined: false,
      });
      const guest = await f.newUser("Oaspete5");
      await acceptInvite(acceptDeps(), guest, { token: created.token });
      const roles = Object.fromEntries(
        (await listMembers(deps(), guest, hh)).map((m) => [m.userId, m.role]),
      );
      expect(roles[guest.userId]).toBe("owner");
      expect(roles[users[1]!.userId]).toBe("member");
    });

    it("limita de rată pe acceptare: încercările greșite se numără", async () => {
      resetCleanupForTests();
      const guest = await f.newUser("Ghicitor");
      const limited = { db: f.db, acceptLimit: { max: 3, windowSeconds: 600 } };
      for (let i = 0; i < 3; i++) {
        await expect(
          acceptInvite(limited, guest, { token: "B".repeat(43) }),
        ).rejects.toBeInstanceOf(InviteUnavailableError);
      }
      await expect(acceptInvite(limited, guest, { token: "B".repeat(43) })).rejects.toBeInstanceOf(
        InviteRateLimitedError,
      );
    });

    it("plafonul de 6 membri: a șaptea acceptare → household_full, invitația rămâne neconsumată", async () => {
      const { hh, users } = await family(["P1", "P2", "P3", "P4", "P5", "P6"]);
      const created = await invited(users[0]!, hh);
      const seventh = await f.newUser("P7");
      await expect(
        acceptInvite(acceptDeps(), seventh, { token: created.token }),
      ).rejects.toMatchObject({ reason: "household_full" });
      const [inv] = await f.admin<{ used_at: Date | null }[]>`
        select used_at from finet.household_invites where id = ${created.invite.id}`;
      expect(inv?.used_at).toBeNull();
    });

    it("doar owner-ul creează, listează și revocă; revocarea e definitivă", async () => {
      const { hh, users } = await family(["Inv8", "Membru8"]);
      const [owner, member] = users as [Actor, Actor];
      await expect(createInvite(deps(), member, hh)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listInvites(deps(), member, hh)).rejects.toBeInstanceOf(ForbiddenError);
      const created = await invited(owner, hh);
      await expect(revokeInvite(deps(), member, hh, created.invite.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      expect((await revokeInvite(deps(), owner, hh, created.invite.id)).status).toBe("revoked");
      await expect(revokeInvite(deps(), owner, hh, created.invite.id)).rejects.toMatchObject({
        reason: "invite_not_active",
      });
      // Străinii (altă gospodărie): 404.
      await expect(createInvite(deps(), f.B, hh)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revokeInvite(deps(), f.B, f.HB, created.invite.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // Validare strictă.
      await expect(createInvite(deps(), owner, hh, { householdId: f.HB })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createInvite(deps(), owner, hh, { expiresInHours: 169 })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("limita zilnică de invitații nu se eliberează prin revocare", async () => {
      const { hh, users } = await family(["Inv9"]);
      for (let i = 0; i < 20; i++) {
        const c = await invited(users[0]!, hh);
        await revokeInvite(deps(), users[0]!, hh, c.invite.id);
      }
      await expect(invited(users[0]!, hh)).rejects.toMatchObject({ reason: "invite_limit" });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("membri, roluri, ultimul owner", () => {
    it("schimbarea rolului: doar owner-ul; ultimul owner nu se retrogradează", async () => {
      const { hh, users } = await family(["R1", "R2"]);
      const [owner, member] = users as [Actor, Actor];
      await expect(
        changeMemberRole(deps(), member, hh, owner.userId, { role: "member" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        changeMemberRole(deps(), owner, hh, owner.userId, { role: "member" }),
      ).rejects.toMatchObject({ reason: "last_owner" });
      expect(
        (await changeMemberRole(deps(), owner, hh, member.userId, { role: "owner" })).role,
      ).toBe("owner");
      // Acum sunt doi: owner-ul se poate retrograda.
      expect(
        (await changeMemberRole(deps(), owner, hh, owner.userId, { role: "member" })).role,
      ).toBe("member");
      await expect(
        changeMemberRole(deps(), member, hh, member.userId, { role: "member" }),
      ).rejects.toMatchObject({ reason: "last_owner" });
      await expect(
        changeMemberRole(deps(), member, hh, owner.userId, { role: "admin" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("ultimul owner: nu pleacă și nu e scos cât timp rămân membri; baza refuză și direct", async () => {
      const { hh, users } = await family(["L1", "L2"]);
      const [owner, member] = users as [Actor, Actor];
      await expect(leaveHousehold(deps(), owner, hh)).rejects.toMatchObject({
        reason: "last_owner",
      });
      // Direct în bază (ocolind serviciul): triggerul refuză.
      expect(
        await sqlState(() =>
          withRlsOn(f.db, { userId: owner.userId, householdId: hh }, (tx) =>
            tx.execute(sql`delete from finet.household_members where user_id = ${owner.userId}`),
          ),
        ),
      ).toBe("23514");
      expect(
        await sqlState(() =>
          withRlsOn(f.db, { userId: owner.userId, householdId: hh }, (tx) =>
            tx.execute(
              sql`update finet.household_members set role = 'member' where user_id = ${owner.userId}`,
            ),
          ),
        ),
      ).toBe("23514");
      // Membrul obișnuit poate pleca.
      await leaveHousehold(deps(), member, hh);
      await expect(listMembers(deps(), member, hh)).rejects.toBeInstanceOf(NotFoundError);
      // Rămas singur, owner-ul nu „pleacă”: gospodăria se șterge.
      await expect(leaveHousehold(deps(), owner, hh)).rejects.toMatchObject({
        reason: "sole_member",
      });
    });

    it("cursa: doi owneri se retrogradează reciproc în paralel → exact unul reușește (lock în bază)", async () => {
      const { hh, users } = await family(["Race1", "Race2"]);
      const [o1, o2] = users as [Actor, Actor];
      await changeMemberRole(deps(), o1, hh, o2.userId, { role: "owner" });
      const demote = (actor: Actor, target: Actor, pause: boolean): Promise<unknown> =>
        withRlsOn(f.db, { userId: actor.userId, householdId: hh }, async (tx) => {
          await tx.execute(
            sql`update finet.household_members set role = 'member' where user_id = ${target.userId}`,
          );
          if (pause) await tx.execute(sql`select pg_sleep(0.4)`);
        });
      const first = demote(o1, o2, true);
      await new Promise((r) => setTimeout(r, 100));
      const second = demote(o2, o1, false);
      const states = await Promise.all([sqlState(() => first), sqlState(() => second)]);
      expect(states.filter((s) => s === null)).toHaveLength(1);
      expect(states.filter((s) => s === "23514")).toHaveLength(1);
      const [n] = await f.admin<{ n: number }[]>`
        select count(*)::int as n from finet.household_members
         where household_id = ${hh} and role = 'owner'`;
      expect(n?.n).toBe(1);
    });

    it("transferul de ownership: atomic, ținta trebuie să fie membru", async () => {
      const { hh, users } = await family(["T1", "T2"]);
      const [owner, member] = users as [Actor, Actor];
      await expect(transferOwnership(deps(), member, hh, owner.userId)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(transferOwnership(deps(), owner, hh, f.B.userId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const after = await transferOwnership(deps(), owner, hh, member.userId);
      expect(Object.fromEntries(after.map((m) => [m.userId, m.role]))).toEqual({
        [owner.userId]: "member",
        [member.userId]: "owner",
      });
      // Fostul owner poate pleca acum.
      await leaveHousehold(deps(), owner, hh);
    });

    it("eliminarea: doar owner-ul, nu pe sine, nu un străin; eliminatul pierde accesul", async () => {
      const { hh, users } = await family(["E1", "E2", "E3"]);
      const [owner, m1, m2] = users as [Actor, Actor, Actor];
      await expect(removeMember(deps(), m1, hh, m2.userId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeMember(deps(), owner, hh, owner.userId)).rejects.toMatchObject({
        reason: "use_leave",
      });
      await expect(removeMember(deps(), owner, hh, f.B.userId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await removeMember(deps(), owner, hh, m1.userId);
      await expect(listMembers(deps(), m1, hh)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listMembers(deps(), owner, hh)).map((m) => m.userId)).toEqual([
        owner.userId,
        m2.userId,
      ]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("comutatorul de gospodărie activă", () => {
    it("setarea verifică apartenența; o preferință rămasă după plecare e ignorată", async () => {
      const { hh, users } = await family(["S1", "S2"]);
      const [owner, member] = users as [Actor, Actor];
      const own = await withRlsOn(f.db, { userId: member.userId }, (tx) =>
        createHousehold(tx, { name: "Personală S2" }),
      );
      const current = () =>
        withRlsOn(f.db, { userId: member.userId }, (tx) => currentHouseholdIdOf(tx, member.userId));
      // Fără preferință: cea mai veche apartenență (hh, unde a fost adăugat întâi).
      expect(await current()).toBe(hh);
      expect((await setActiveHousehold(deps(), member, { householdId: own })).current).toBe(true);
      expect(await current()).toBe(own);
      expect((await setActiveHousehold(deps(), member, { householdId: hh })).current).toBe(true);
      expect(await current()).toBe(hh);
      // Străină: 404, preferința nu se schimbă.
      await expect(
        setActiveHousehold(deps(), member, { householdId: f.HB }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await current()).toBe(hh);
      // Scos din hh, cu preferința forțată (direct în bază) pe hh: se ignoră la fiecare cerere.
      await removeMember(deps(), owner, hh, member.userId);
      await f.admin`update finet.user_preferences set active_household_id = ${hh}
                     where user_id = ${member.userId}`;
      expect(await current()).toBe(own);
      await expect(
        setActiveHousehold(deps(), member, { householdId: hh, extra: true }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("împărțiri, solduri, decontări", () => {
    it("toate modurile: suma părților = totalul (inclusiv rotunjiri), verificat și în bază", async () => {
      const { hh, users } = await family(["Sp1", "Sp2", "Sp3"]);
      const [a, b, c] = users as [Actor, Actor, Actor];
      const ids = users.map((u) => u.userId);
      const { transactionId } = await personalExpense(a, hh, 10_001, "Card Sp1");
      const eq = await setTransactionSplit(deps(), a, hh, transactionId, {
        mode: "equal",
        userIds: [c.userId, b.userId, a.userId],
      });
      expect(eq.totalMinor).toBe(10_001n);
      expect(eq.shares.reduce((s, x) => s + x.shareMinor, 0n)).toBe(10_001n);
      const pct = await setTransactionSplit(deps(), a, hh, transactionId, {
        mode: "percent",
        shares: [
          { userId: ids[0]!, basisPoints: 3334 },
          { userId: ids[1]!, basisPoints: 3333 },
          { userId: ids[2]!, basisPoints: 3333 },
        ],
      });
      expect(pct.shares.reduce((s, x) => s + x.shareMinor, 0n)).toBe(10_001n);
      const fixed = await setTransactionSplit(deps(), a, hh, transactionId, {
        mode: "fixed",
        shares: [
          { userId: a.userId, amountMinor: 1 },
          { userId: b.userId, amountMinor: 10_000 },
        ],
      });
      expect(fixed.shares.map((s) => s.shareMinor)).toEqual(
        [a.userId, b.userId].sort().map((u) => (u === a.userId ? 1n : 10_000n)),
      );
      // Sume care nu bat: respinse în serviciu.
      await expect(
        setTransactionSplit(deps(), a, hh, transactionId, {
          mode: "fixed",
          shares: [
            { userId: a.userId, amountMinor: 1 },
            { userId: b.userId, amountMinor: 1 },
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setTransactionSplit(deps(), a, hh, transactionId, {
          mode: "percent",
          shares: [
            { userId: a.userId, basisPoints: 5000 },
            { userId: b.userId, basisPoints: 4000 },
          ],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      // ... și în bază (ocolind serviciul): o parte în plus → 23514 la COMMIT.
      expect(
        await sqlState(() =>
          withRlsOn(f.db, { userId: a.userId, householdId: hh }, (tx) =>
            tx.execute(sql`insert into finet.transaction_splits
              (household_id, transaction_id, payer_user_id, user_id, share_minor, currency)
              values (${hh}, ${transactionId}, ${a.userId}, ${c.userId}, 5, 'RON')`),
          ),
        ),
      ).toBe("23514");
      // Modificarea sumei unei tranzacții împărțite: 409 în serviciu, 23514 direct în bază.
      await expect(
        updateTransaction(deps(), a, hh, transactionId, { amountMinor: 500 }),
      ).rejects.toMatchObject({ reason: "transaction_split" });
      expect(
        await sqlState(() =>
          withRlsOn(f.db, { userId: a.userId, householdId: hh }, (tx) =>
            tx.execute(
              sql`update finet.transactions set amount_minor = 500 where id = ${transactionId}`,
            ),
          ),
        ),
      ).toBe("23514");
      // Descrierea se poate schimba.
      expect(
        (await updateTransaction(deps(), a, hh, transactionId, { description: "Cumpărături" }))
          .description,
      ).toBe("Cumpărături");
      // Ștergerea unei cheltuieli împărțite: refuzată (ar schimba în tăcere soldurile tuturor).
      await expect(deleteTransaction(deps(), a, hh, transactionId)).rejects.toMatchObject({
        reason: "transaction_split",
      });
      // Ștergerea împărțirii: doar plătitorul.
      await expect(clearTransactionSplit(deps(), b, hh, transactionId)).rejects.toMatchObject({
        reason: "split_not_payer",
      });
      await clearTransactionSplit(deps(), a, hh, transactionId);
      await expect(getTransactionSplit(deps(), a, hh, transactionId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // Fără împărțire, suma se poate schimba din nou.
      expect(
        (await updateTransaction(deps(), a, hh, transactionId, { amountMinor: 500 })).amountMinor,
      ).toBe(500n);
      await deleteTransaction(deps(), a, hh, transactionId);
    });

    it("reguli: doar cheltuieli din contul PERSONAL al plătitorului, participanți membri", async () => {
      const { hh, users } = await family(["Rg1", "Rg2"]);
      const [a, b] = users as [Actor, Actor];
      const common = await createAccount(deps(), a, hh, {
        name: "Comun Rg",
        type: "bank",
        currency: "RON",
      });
      const onCommon = await createTransaction(deps(), a, hh, {
        accountId: common.id,
        type: "expense",
        amountMinor: 100,
        occurredOn: "2026-10-10",
      });
      const equal = { mode: "equal", userIds: [a.userId, b.userId] };
      await expect(setTransactionSplit(deps(), a, hh, onCommon.id, equal)).rejects.toMatchObject({
        reason: "split_requires_personal_account",
      });
      const { transactionId, accountId } = await personalExpense(a, hh, 100, "Card Rg1");
      const income = await createTransaction(deps(), a, hh, {
        accountId,
        type: "income",
        amountMinor: 100,
        occurredOn: "2026-10-10",
      });
      await expect(setTransactionSplit(deps(), a, hh, income.id, equal)).rejects.toMatchObject({
        reason: "split_not_expense",
      });
      // B nu vede tranzacția personală a lui A: 404 (nu 403, nu „există”).
      await expect(setTransactionSplit(deps(), b, hh, transactionId, equal)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // Un străin ca participant.
      await expect(
        setTransactionSplit(deps(), a, hh, transactionId, {
          mode: "equal",
          userIds: [a.userId, f.B.userId],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Câmpuri nepermise (plătitorul nu se alege).
      await expect(
        setTransactionSplit(deps(), a, hh, transactionId, { ...equal, payerUserId: b.userId }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Direct în bază: B nu poate scrie o împărțire în numele lui A (triggerul nu găsește
      // tranzacția sub RLS-ul lui B → 23503; altfel politica → 42501).
      expect(
        await sqlState(() =>
          withRlsOn(f.db, { userId: b.userId, householdId: hh }, (tx) =>
            tx.execute(sql`insert into finet.transaction_splits
              (household_id, transaction_id, payer_user_id, user_id, share_minor, currency)
              values (${hh}, ${transactionId}, ${a.userId}, ${b.userId}, 100, 'RON')`),
          ),
        ),
      ).toMatch(/^(42501|23503)$/);
    });

    it("solduri cu 2 membri: aceleași văzute de amândoi; decontare parțială, apoi 0", async () => {
      const { hh, users } = await family(["Bal1", "Bal2"]);
      const [a, b] = users as [Actor, Actor];
      const { transactionId } = await personalExpense(a, hh, 10_000, "Card Bal1");
      await setTransactionSplit(deps(), a, hh, transactionId, {
        mode: "equal",
        userIds: [a.userId, b.userId],
      });
      const asA = await getBalances(deps(), a, hh);
      const asB = await getBalances(deps(), b, hh);
      expect(asA.currencies).toEqual(asB.currencies);
      expect(asA.currencies[0]!.pairs).toEqual([
        { debtorUserId: b.userId, creditorUserId: a.userId, amountMinor: 5_000n },
      ]);
      expect(asA.me).toEqual([{ currency: "RON", owesMinor: 0n, owedMinor: 5_000n }]);
      expect(asB.me).toEqual([{ currency: "RON", owesMinor: 5_000n, owedMinor: 0n }]);
      const partial = await createSettlement(deps(), b, hh, {
        fromUserId: b.userId,
        toUserId: a.userId,
        amount: "20,00",
        currency: "RON",
        settledOn: "2026-10-11",
        note: "Parțial",
      });
      expect(partial.amountMinor).toBe(2_000n);
      expect((await getBalances(deps(), a, hh)).currencies[0]!.pairs).toEqual([
        { debtorUserId: b.userId, creditorUserId: a.userId, amountMinor: 3_000n },
      ]);
      await createSettlement(deps(), b, hh, {
        fromUserId: b.userId,
        toUserId: a.userId,
        amountMinor: 3_000,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      const zero = await getBalances(deps(), b, hh);
      expect(zero.currencies[0]!.pairs).toEqual([]);
      expect(zero.me).toEqual([{ currency: "RON", owesMinor: 0n, owedMinor: 0n }]);
      expect(JSON.stringify(balancesToJson(zero))).toContain('"netMinor":0');
      // Anularea unei decontări redeschide soldul.
      await cancelSettlement(deps(), b, hh, partial.id);
      expect((await getBalances(deps(), a, hh)).currencies[0]!.pairs).toEqual([
        { debtorUserId: b.userId, creditorUserId: a.userId, amountMinor: 2_000n },
      ]);
      expect((await listSettlements(deps(), a, hh)).map((s) => s.id)).not.toContain(partial.id);
      expect(
        (await listSettlements(deps(), a, hh, { includeCancelled: true })).map((s) => s.id),
      ).toContain(partial.id);
      expect(splitToJson((await listSplits(deps(), b, hh))[0]!).totalMinor).toBe(10_000);
    });

    it("solduri cu 3 membri: netting pe perechi, identice pentru fiecare membru, ajung la 0", async () => {
      const { hh, users } = await family(["Tri1", "Tri2", "Tri3"]);
      const [a, b, c] = users as [Actor, Actor, Actor];
      const all = users.map((u) => u.userId);
      const ta = await personalExpense(a, hh, 9_000, "Card Tri1");
      await setTransactionSplit(deps(), a, hh, ta.transactionId, { mode: "equal", userIds: all });
      const tb = await personalExpense(b, hh, 6_000, "Card Tri2");
      await setTransactionSplit(deps(), b, hh, tb.transactionId, {
        mode: "equal",
        userIds: [b.userId, c.userId],
      });
      const tc = await personalExpense(c, hh, 2_000, "Card Tri3");
      await setTransactionSplit(deps(), c, hh, tc.transactionId, {
        mode: "percent",
        shares: [
          { userId: a.userId, basisPoints: 5000 },
          { userId: c.userId, basisPoints: 5000 },
        ],
      });
      const views = await Promise.all(users.map((u) => getBalances(deps(), u, hh)));
      expect(views[1]!.currencies).toEqual(views[0]!.currencies);
      expect(views[2]!.currencies).toEqual(views[0]!.currencies);
      const ron = views[0]!.currencies[0]!;
      const pair = (debtor: Actor, creditor: Actor) =>
        ron.pairs.find(
          (p) => p.debtorUserId === debtor.userId && p.creditorUserId === creditor.userId,
        )?.amountMinor ?? 0n;
      expect(pair(b, a)).toBe(3_000n);
      expect(pair(c, a)).toBe(2_000n); // 3000 − 1000
      expect(pair(c, b)).toBe(3_000n);
      const net = Object.fromEntries(ron.members.map((m) => [m.userId, m.netMinor]));
      expect(net[a.userId]).toBe(5_000n);
      expect(net[b.userId]).toBe(0n);
      expect(net[c.userId]).toBe(-5_000n);
      // Fiecare își vede propriul rezumat.
      expect(views[2]!.me).toEqual([{ currency: "RON", owesMinor: 5_000n, owedMinor: 0n }]);
      // Decontările (inclusiv una înregistrată de owner pentru alți doi) aduc totul la 0.
      await createSettlement(deps(), b, hh, {
        fromUserId: b.userId,
        toUserId: a.userId,
        amountMinor: 3_000,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      await createSettlement(deps(), c, hh, {
        fromUserId: c.userId,
        toUserId: a.userId,
        amountMinor: 2_000,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      await createSettlement(deps(), a, hh, {
        fromUserId: c.userId,
        toUserId: b.userId,
        amountMinor: 3_000,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      for (const u of users) {
        const v = await getBalances(deps(), u, hh);
        expect(v.currencies[0]!.pairs).toEqual([]);
        expect(v.currencies[0]!.members.every((m) => m.netMinor === 0n)).toBe(true);
      }
      // Acum C poate pleca.
      await leaveHousehold(deps(), c, hh);
    });

    it("permisiunile decontărilor: parte sau owner (doar pe o datorie existentă); anulează părțile sau creatorul, nu un owner străin", async () => {
      const { hh, users } = await family(["Dec1", "Dec2", "Dec3"]);
      const [owner, m1, m2] = users as [Actor, Actor, Actor];
      // m1 plătește 300 pentru toți trei: owner și m2 îi datorează câte 100.
      const { transactionId } = await personalExpense(m1, hh, 300, "Card Dec2");
      await setTransactionSplit(deps(), m1, hh, transactionId, {
        mode: "equal",
        userIds: users.map((u) => u.userId),
      });
      const input = (from: Actor, to: Actor, amountMinor = 100) => ({
        fromUserId: from.userId,
        toUserId: to.userId,
        amountMinor,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      await expect(createSettlement(deps(), m1, hh, input(m2, owner))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // Owner-ul (nu e parte) stinge o datorie existentă, nu mai mult.
      await expect(createSettlement(deps(), owner, hh, input(m2, m1, 101))).rejects.toMatchObject({
        reason: "settlement_exceeds_debt",
      });
      const byOwner = await createSettlement(deps(), owner, hh, input(m2, m1));
      // Primitorul (m1) înregistrează orice sumă primită.
      const byM1 = await createSettlement(deps(), m1, hh, input(owner, m1));
      // Un membru care nu e parte și nu a creat-o: nu anulează.
      await expect(cancelSettlement(deps(), m2, hh, byM1.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // O parte (m1 = primitorul) anulează decontarea creată de owner.
      expect((await cancelSettlement(deps(), m1, hh, byOwner.id)).cancelledByUserId).toBe(
        m1.userId,
      );
      // Owner-ul anulează una în care e parte (plătitorul).
      expect((await cancelSettlement(deps(), owner, hh, byM1.id)).cancelledByUserId).toBe(
        owner.userId,
      );
      await expect(cancelSettlement(deps(), owner, hh, byM1.id)).rejects.toMatchObject({
        reason: "settlement_already_cancelled",
      });
      // Owner-ul care nu e parte și nu a creat-o NU o anulează.
      const byM2 = await createSettlement(deps(), m2, hh, input(m2, m1));
      await expect(cancelSettlement(deps(), owner, hh, byM2.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // Validare: aceeași persoană, străin, sumă invalidă, câmp nepermis.
      await expect(createSettlement(deps(), m1, hh, input(m1, m1))).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(createSettlement(deps(), owner, hh, input(m1, f.B))).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        createSettlement(deps(), m1, hh, { ...input(m1, m2), amountMinor: 0 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createSettlement(deps(), m1, hh, { ...input(m1, m2), amountMinor: 1.5 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        createSettlement(deps(), m1, hh, { ...input(m1, m2), createdByUserId: m2.userId }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Direct în bază: un membru nu „anulează” în numele altuia, nu reactivează, nu șterge.
      const as = (actor: Actor, statement: SQL) =>
        sqlState(() =>
          withRlsOn(f.db, { userId: actor.userId, householdId: hh }, (tx) => tx.execute(statement)),
        );
      expect(
        await as(
          owner,
          sql`update finet.settlements set cancelled_at = null where id = ${byM1.id}`,
        ),
      ).toBe("23514");
      expect(await as(owner, sql`delete from finet.settlements where id = ${byOwner.id}`)).toBe(
        "42501",
      );
      expect(
        await as(
          owner,
          sql`update finet.settlements set amount_minor = 1 where id = ${byOwner.id}`,
        ),
      ).toBe("42501");
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("revizuirea de securitate (M1, M2, m4)", () => {
    it("M1: invitațiile unui owner scos, retrogradat sau plecat se revocă; plasa din bază le refuză oricum", async () => {
      const { hh, users } = await family(["M1a", "M1b", "M1c"]);
      const [o1, o2, o3] = users as [Actor, Actor, Actor];
      await changeMemberRole(deps(), o1, hh, o2.userId, { role: "owner" });
      await changeMemberRole(deps(), o1, hh, o3.userId, { role: "owner" });
      const fromO2 = await invited(o2, hh);
      const fromO3 = await invited(o3, hh);
      const fromO1 = await invited(o1, hh);
      // Retrogradare (o2), eliminare (o3): invitațiile lor devin revocate.
      await changeMemberRole(deps(), o1, hh, o2.userId, { role: "member" });
      await removeMember(deps(), o1, hh, o3.userId);
      const status = async () =>
        Object.fromEntries(
          (await listInvites(deps(), o1, hh)).map((i) => [i.id, i.status] as const),
        );
      expect(await status()).toMatchObject({
        [fromO2.invite.id]: "revoked",
        [fromO3.invite.id]: "revoked",
        [fromO1.invite.id]: "active",
      });
      const guest = await f.newUser("M1g");
      for (const t of [fromO2.token, fromO3.token]) {
        await expect(acceptInvite(acceptDeps(), guest, { token: t })).rejects.toBeInstanceOf(
          InviteUnavailableError,
        );
      }
      // Transferul de ownership revocă invitațiile celui care cedează.
      await transferOwnership(deps(), o1, hh, o2.userId);
      const [o1Invite] = await f.admin<{ revoked: boolean }[]>`
        select revoked_at is not null as revoked from finet.household_invites
         where id = ${fromO1.invite.id}`;
      expect(o1Invite?.revoked).toBe(true);
    }, 120_000);

    it("M1: plasa din bază — creatorul retrogradat direct (ocolind serviciul) → invitația e inutilizabilă, răspuns uniform", async () => {
      const { hh, users } = await family(["M1d", "M1e"]);
      const [o1, o2] = users as [Actor, Actor];
      await changeMemberRole(deps(), o1, hh, o2.userId, { role: "owner" });
      const fromO2 = await invited(o2, hh);
      await f.admin`update finet.household_members set role = 'member'
                     where household_id = ${hh} and user_id = ${o2.userId}`;
      const guest = await f.newUser("M1h");
      await expect(
        acceptInvite(acceptDeps(), guest, { token: fromO2.token }),
      ).rejects.toBeInstanceOf(InviteUnavailableError);
      const [inv] = await f.admin<{ used_at: Date | null; revoked_at: Date | null }[]>`
        select used_at, revoked_at from finet.household_invites where id = ${fromO2.invite.id}`;
      expect(inv).toEqual({ used_at: null, revoked_at: null });
    });

    it("M2: plătitorul doar în limita datoriei lui; creditorul nu-și creează creanțe; destinatarul orice sumă", async () => {
      const { hh, users } = await family(["M2a", "M2b", "M2c"]);
      const [a, b, c] = users as [Actor, Actor, Actor];
      const { transactionId } = await personalExpense(a, hh, 100, "Card M2a");
      await setTransactionSplit(deps(), a, hh, transactionId, {
        mode: "equal",
        userIds: [a.userId, b.userId],
      });
      const settle = (actor: Actor, from: Actor, to: Actor, amountMinor: number) =>
        createSettlement(deps(), actor, hh, {
          fromUserId: from.userId,
          toUserId: to.userId,
          amountMinor,
          currency: "RON",
          settledOn: "2026-10-12",
        });
      const pairBA = async () =>
        (await getBalances(deps(), a, hh)).currencies[0]?.pairs.find(
          (p) => p.debtorUserId === b.userId && p.creditorUserId === a.userId,
        )?.amountMinor ?? 0n;
      // B îi datorează 50: nu poate declara 60 (ar inversa sensul în favoarea lui).
      await expect(settle(b, b, a, 60)).rejects.toMatchObject({
        reason: "settlement_exceeds_debt",
      });
      // Fără datorie (C ↔ A): nici declarația de plată, nici owner-ul nu o pot crea.
      await expect(settle(c, c, a, 1)).rejects.toMatchObject({
        reason: "settlement_exceeds_debt",
      });
      // Creditorul (A) NU poate înregistra singur o „plată” spre debitor (și-ar crea o creanță).
      await expect(settle(a, a, b, 10)).rejects.toMatchObject({
        reason: "settlement_exceeds_debt",
      });
      // Corecția în favoarea lui A o înregistrează B, ca destinatar: B datorează 60.
      await settle(b, a, b, 10);
      expect(await pairBA()).toBe(60n);
      await settle(b, b, a, 60);
      expect(await pairBA()).toBe(0n);
      // Datoria stinsă: încă 1 → refuzat.
      await expect(settle(b, b, a, 1)).rejects.toMatchObject({ reason: "settlement_exceeds_debt" });
      // Primitorul poate înregistra orice sumă (în defavoarea lui): A „a primit” 5 de la B.
      await settle(a, b, a, 5);
      const pairs = (await getBalances(deps(), b, hh)).currencies[0]!.pairs;
      expect(pairs).toEqual([
        { debtorUserId: a.userId, creditorUserId: b.userId, amountMinor: 5n },
      ]);
    });

    it("M2: plecarea și eliminarea nu mai sunt blocate de sold: `unsettledBalance`, fostul membru rămâne în solduri", async () => {
      const { hh, users } = await family(["M2d", "M2e", "M2f"]);
      const [owner, m1, m2] = users as [Actor, Actor, Actor];
      const { transactionId } = await personalExpense(owner, hh, 300, "Card M2d");
      await setTransactionSplit(deps(), owner, hh, transactionId, {
        mode: "equal",
        userIds: users.map((u) => u.userId),
      });
      expect(await leaveHousehold(deps(), m1, hh)).toEqual({ unsettledBalance: true });
      expect(await removeMember(deps(), owner, hh, m2.userId)).toEqual({
        unsettledBalance: true,
      });
      const view = await getBalances(deps(), owner, hh);
      expect(view.formerMemberIds).toEqual([m1.userId, m2.userId].sort());
      expect(view.me).toEqual([{ currency: "RON", owesMinor: 0n, owedMinor: 200n }]);
      // Fără sold: `unsettledBalance: false`.
      const other = await family(["M2g", "M2h"]);
      expect(await leaveHousehold(deps(), other.users[1]!, other.hh)).toEqual({
        unsettledBalance: false,
      });
    });

    it("m4: soldul unei perechi nu trece de plafon (decontări, împărțiri, anulări)", async () => {
      const { hh, users } = await family(["M4a", "M4b"]);
      const [a, b] = users as [Actor, Actor];
      // ~900 de decontări de 10^13 ar fi trecut de 2^53; aici aducem perechea la plafon direct.
      const cap = 100_000_000_000_000n;
      await f.admin`insert into finet.settlements
          (household_id, from_user_id, to_user_id, amount_minor, currency, settled_on, created_by_user_id)
        select ${hh}, ${a.userId}, ${b.userId}, 10000000000000, 'RON', '2026-10-01', ${a.userId}
          from generate_series(1, 10)`;
      // B îi datorează acum lui A exact plafonul (10 × 10^13).
      const pair = (await getBalances(deps(), a, hh)).currencies[0]!.pairs[0]!;
      expect(pair).toEqual({ debtorUserId: b.userId, creditorUserId: a.userId, amountMinor: cap });
      // Creditorul nu înregistrează singur o plată spre debitor; destinatarul (B) da, dar ar
      // trece de plafon.
      await expect(
        createSettlement(deps(), a, hh, {
          fromUserId: a.userId,
          toUserId: b.userId,
          amountMinor: 1,
          currency: "RON",
          settledOn: "2026-10-12",
        }),
      ).rejects.toMatchObject({ reason: "settlement_exceeds_debt" });
      await expect(
        createSettlement(deps(), b, hh, {
          fromUserId: a.userId,
          toUserId: b.userId,
          amountMinor: 1,
          currency: "RON",
          settledOn: "2026-10-12",
        }),
      ).rejects.toMatchObject({ reason: "balance_limit" });
      // O împărțire care ar crește datoria lui B.
      const { transactionId } = await personalExpense(a, hh, 2, "Card M4a");
      await expect(
        setTransactionSplit(deps(), a, hh, transactionId, {
          mode: "equal",
          userIds: [a.userId, b.userId],
        }),
      ).rejects.toMatchObject({ reason: "balance_limit" });
      // Stingerea parțială merge; anularea ei ar readuce perechea la plafon (încă permis), dar
      // nu peste.
      const partial = await createSettlement(deps(), b, hh, {
        fromUserId: b.userId,
        toUserId: a.userId,
        amountMinor: 1,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      await createSettlement(deps(), b, hh, {
        fromUserId: a.userId,
        toUserId: b.userId,
        amountMinor: 1,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      await expect(cancelSettlement(deps(), b, hh, partial.id)).rejects.toMatchObject({
        reason: "balance_limit",
      });
      expect(JSON.stringify(balancesToJson(await getBalances(deps(), a, hh)))).toContain(
        String(cap),
      );
    });
  });

  // ------------------------------------------------------------------------------------------
  describe("izolare între gospodării (fiecare serviciu)", () => {
    it("un străin primește 404 pe toate serviciile familiei; inexistentul tot 404", async () => {
      const { hh, users } = await family(["Iz1", "Iz2"]);
      const [a] = users as [Actor];
      const { transactionId } = await (async () => {
        const acc = await createAccount(deps(), a, hh, {
          name: "Card Iz",
          type: "cash",
          currency: "RON",
          ownerUserId: a.userId,
        });
        const t = await createTransaction(deps(), a, hh, {
          accountId: acc.id,
          type: "expense",
          amountMinor: 100,
          occurredOn: "2026-10-10",
        });
        return { transactionId: t.id };
      })();
      await setTransactionSplit(deps(), a, hh, transactionId, {
        mode: "equal",
        userIds: users.map((u) => u.userId),
      });
      const s = await createSettlement(deps(), a, hh, {
        fromUserId: users[1]!.userId,
        toUserId: a.userId,
        amountMinor: 10,
        currency: "RON",
        settledOn: "2026-10-12",
      });
      const inv = await createInvite(deps(), a, hh);
      const stranger = f.B;
      const ops: Array<() => Promise<unknown>> = [
        () => listMembers(deps(), stranger, hh),
        () => changeMemberRole(deps(), stranger, hh, a.userId, { role: "member" }),
        () => removeMember(deps(), stranger, hh, a.userId),
        () => leaveHousehold(deps(), stranger, hh),
        () => transferOwnership(deps(), stranger, hh, a.userId),
        () => listInvites(deps(), stranger, hh),
        () => revokeInvite(deps(), stranger, hh, inv.invite.id),
        () => getBalances(deps(), stranger, hh),
        () => listSettlements(deps(), stranger, hh),
        () => cancelSettlement(deps(), stranger, hh, s.id),
        () => listSplits(deps(), stranger, hh),
        () => getTransactionSplit(deps(), stranger, hh, transactionId),
        () => clearTransactionSplit(deps(), stranger, hh, transactionId),
        // Prin propria gospodărie, cu id-urile altei gospodării.
        () => getTransactionSplit(deps(), stranger, f.HB, transactionId),
        () => cancelSettlement(deps(), stranger, f.HB, s.id),
        () => revokeInvite(deps(), stranger, f.HB, inv.invite.id),
        () => removeMember(deps(), stranger, f.HB, a.userId),
        () => getTransactionSplit(deps(), a, hh, "nu-e-uuid"),
      ];
      for (const op of ops) await expect(op()).rejects.toBeInstanceOf(NotFoundError);
      // Străinul nu vede nimic din gospodăria lui A în propria gospodărie.
      expect((await getBalances(deps(), stranger, f.HB)).currencies).toEqual([]);
      expect(await listSettlements(deps(), stranger, f.HB)).toEqual([]);
      expect(await listSplits(deps(), stranger, f.HB)).toEqual([]);
    });
  });

  it("auditul familiei nu conține tokenuri, sume sau note", async () => {
    const rows = await f.admin<{ action: string; metadata: unknown }[]>`
      select action, metadata from finet.audit_events
       where action like 'household.%' or action like 'settlement.%' or action like 'transaction.split%'`;
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/token|amount|note|Parțial|[A-Za-z0-9_-]{43}/);
  });

  it("erorile de domeniu nu conțin parametri", () => {
    const e = new ConflictError("last_owner");
    expect(e.message).not.toContain("00000000");
  });
});
