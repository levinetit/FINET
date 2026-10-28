import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { MoneyOverflowError } from "@/lib/money";
import { archiveAccount, createAccount } from "@/modules/accounts/accounts.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { deleteTransaction } from "@/modules/transactions/transactions.service";

import { selectDueRules } from "./recurring.repo";
import { MAX_CATCH_UP_PER_RUN, recurringRuleToJson } from "./recurring.schema";
import {
  createRecurringRule,
  deleteRecurringRule,
  generateDueForHousehold,
  generateDueForRule,
  getRecurringRule,
  listRecurringRules,
  pauseRecurringRule,
  resumeRecurringRule,
  runDueRecurring,
  updateRecurringRule,
} from "./recurring.service";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

describe.skipIf(!TEST_ADMIN_URL)("recurențe (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let eur: string;
  let accB: string;
  let subs: string;
  let salary: string;

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_recurring");
    ron = (await createAccount(f.deps, f.A, f.HA, { name: "Card", type: "bank", currency: "RON" }))
      .id;
    eur = (await createAccount(f.deps, f.A, f.HA, { name: "EUR", type: "bank", currency: "EUR" }))
      .id;
    accB = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" }))
      .id;
    subs = await systemCategoryId(f.admin, "expense.subscriptions");
    salary = await systemCategoryId(f.admin, "income.salary");
  });
  afterAll(async () => {
    await f?.close();
  });

  const rule = (input: Record<string, unknown>, actor = f.A, household = f.HA) =>
    createRecurringRule(f.deps, actor, household, {
      accountId: ron,
      type: "expense",
      amountMinor: 4999,
      description: "Abonament",
      frequency: "monthly",
      startOn: "2026-01-31",
      ...input,
    });

  /** Tranzacțiile generate de o regulă (ca superuser: fără RLS). */
  const generated = (ruleId: string) =>
    f.admin<
      { occurred_on: string; source: string; amount_minor: string; created_by_user_id: string }[]
    >`
      select occurred_on::text, source, amount_minor::text, created_by_user_id
        from finet.transactions where recurring_rule_id = ${ruleId} order by occurred_on`;
  const occurrences = (ruleId: string) =>
    f.admin<{ occurrence_date: string; transaction_id: string | null }[]>`
      select occurrence_date::text, transaction_id from finet.recurring_occurrences
       where rule_id = ${ruleId} order by occurrence_date`;

  it("creare: validare strictă, cont străin → 404, categorie de alt tip → 400, fără scadență → 400", async () => {
    await expect(rule({ householdId: f.HB })).rejects.toBeInstanceOf(ValidationError);
    await expect(rule({ accountId: accB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(rule({ categoryId: salary })).rejects.toBeInstanceOf(ValidationError);
    await expect(rule({ frequency: "weekly", dayOfMonth: 3 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(rule({ amountMinor: 10_000_000_000_001 })).rejects.toBeInstanceOf(ValidationError);
    await expect(rule({ amountMinor: 1.5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(rule({ interval: 0 })).rejects.toBeInstanceOf(ValidationError);
    // Ziua țintă 31, început pe 15, sfârșit pe 20: nicio scadență.
    await expect(
      rule({ startOn: "2026-03-15", dayOfMonth: 31, endOn: "2026-03-20" }),
    ).rejects.toBeInstanceOf(ValidationError);
    // B nu poate crea în gospodăria A.
    await expect(rule({}, f.B, f.HA)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creare: moneda contului, ziua implicită din startOn, scadența calculată; JSON cu întregi", async () => {
    const r = await rule({
      accountId: eur,
      amountMinor: undefined,
      amount: "12,50",
      categoryId: subs,
    });
    expect(r).toMatchObject({
      currency: "EUR",
      amountMinor: 1250n,
      dayOfMonth: 31,
      nextRunOn: "2026-01-31",
      status: "active",
      interval: 1,
      occurrencesCount: 0,
    });
    expect(recurringRuleToJson(r).amountMinor).toBe(1250);
    await deleteRecurringRule(f.deps, f.A, f.HA, r.id);
  });

  it("generare lunară: ziua 31 → ultima zi a lunii; sursa `recurring`, legătura, creatorul", async () => {
    const r = await rule({ description: "Chirie" });
    const res = await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-04-15");
    expect(res).toMatchObject({ outcome: "generated", generated: 3, nextRunOn: "2026-04-30" });
    const rows = await generated(r.id);
    expect(rows.map((x) => x.occurred_on)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(new Set(rows.map((x) => x.source))).toEqual(new Set(["recurring"]));
    expect(new Set(rows.map((x) => x.amount_minor))).toEqual(new Set(["4999"]));
    expect(new Set(rows.map((x) => x.created_by_user_id))).toEqual(new Set([f.A.userId]));
    const view = await getRecurringRule(f.deps, f.A, f.HA, r.id, "2026-04-15");
    expect(view).toMatchObject({ occurrencesCount: 3, due: false });

    // A doua generare: nimic nou.
    const again = await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-04-15");
    expect(again).toMatchObject({ outcome: "not_due", generated: 0 });
    expect(await generated(r.id)).toHaveLength(3);
  });

  it("idempotență: 5 rulări paralele (regula + gospodăria + workerul) → 0 duplicate", async () => {
    const r = await rule({ description: "Paralel", startOn: "2026-01-10", dayOfMonth: 10 });
    const today = "2026-06-15";
    await Promise.all([
      generateDueForRule(f.deps, f.A, f.HA, r.id, today),
      generateDueForRule(f.deps, f.C, f.HA, r.id, today),
      generateDueForHousehold(f.deps, f.A, f.HA, today),
      runDueRecurring(f.deps, today),
      runDueRecurring(f.deps, today),
    ]);
    // Rulările blocate de SKIP LOCKED au sărit regula; o ultimă rulare termină ce a rămas.
    await generateDueForRule(f.deps, f.A, f.HA, r.id, today);
    const rows = await generated(r.id);
    expect(rows.map((x) => x.occurred_on)).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
      "2026-04-10",
      "2026-05-10",
      "2026-06-10",
    ]);
    expect(await occurrences(r.id)).toHaveLength(6);
    const view = await getRecurringRule(f.deps, f.A, f.HA, r.id, today);
    expect(view).toMatchObject({ occurrencesCount: 6, nextRunOn: "2026-07-10" });
  });

  it("eșec forțat pe al doilea rând: tot lotul regulii e anulat, regula neschimbată", async () => {
    const r = await rule({ description: "Esec", startOn: "2026-01-05", dayOfMonth: 5 });
    await f.admin.unsafe(`
      create function finet.test_fail_second() returns trigger language plpgsql as $$
      begin
        if new.description = 'Esec' and new.occurred_on = date '2026-02-05' then
          raise exception 'eșec de test' using errcode = 'P0001';
        end if;
        return new;
      end $$;
      create trigger test_fail_second before insert on finet.transactions
        for each row execute function finet.test_fail_second();`);
    try {
      await expect(generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-03-10")).rejects.toThrow();
      expect(await generated(r.id)).toHaveLength(0);
      expect(await occurrences(r.id)).toHaveLength(0);
      const view = await getRecurringRule(f.deps, f.A, f.HA, r.id, "2026-03-10");
      expect(view).toMatchObject({
        occurrencesCount: 0,
        nextRunOn: "2026-01-05",
        status: "active",
      });
    } finally {
      await f.admin.unsafe(`drop trigger test_fail_second on finet.transactions;
        drop function finet.test_fail_second();`);
    }
    // După înlăturarea cauzei, generarea reușește complet.
    const ok = await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-03-10");
    expect(ok.generated).toBe(3);
  });

  it("pauză și reluare: lunile sărite NU se generează retroactiv", async () => {
    const r = await rule({ description: "Sala", startOn: "2026-01-10", dayOfMonth: 10 });
    expect((await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-01-15")).generated).toBe(1);
    const paused = await pauseRecurringRule(f.deps, f.A, f.HA, r.id);
    expect(paused.status).toBe("paused");
    expect(await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-05-20")).toMatchObject({
      outcome: "inactive",
      generated: 0,
    });
    const resumed = await resumeRecurringRule(f.deps, f.A, f.HA, r.id, "2026-05-20");
    expect(resumed).toMatchObject({ status: "active", nextRunOn: "2026-06-10" });
    expect((await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-05-20")).generated).toBe(0);
    // Reluarea chiar în ziua scadenței o include (prima scadență ≥ azi).
    await pauseRecurringRule(f.deps, f.A, f.HA, r.id);
    const sameDay = await resumeRecurringRule(f.deps, f.A, f.HA, r.id, "2026-06-10");
    expect(sameDay.nextRunOn).toBe("2026-06-10");
    expect((await generated(r.id)).map((x) => x.occurred_on)).toEqual(["2026-01-10"]);
  });

  it("recuperare limitată: 14 luni ratate → 12 acum, 2 la rularea următoare", async () => {
    const r = await rule({ description: "Rata", startOn: "2025-01-05", dayOfMonth: 5 });
    const first = await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-02-10");
    expect(first).toMatchObject({ generated: MAX_CATCH_UP_PER_RUN, remainingDue: true });
    const second = await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-02-10");
    expect(second).toMatchObject({ generated: 2, remainingDue: false, nextRunOn: "2026-03-05" });
    expect(await generated(r.id)).toHaveLength(14);
  });

  it("completed: după numărul de rate și după end_on", async () => {
    const rate = await rule({
      description: "3 rate",
      startOn: "2026-01-01",
      dayOfMonth: 1,
      maxOccurrences: 3,
    });
    const res = await generateDueForRule(f.deps, f.A, f.HA, rate.id, "2026-12-31");
    expect(res).toMatchObject({ generated: 3, status: "completed" });
    expect(await generateDueForRule(f.deps, f.A, f.HA, rate.id, "2026-12-31")).toMatchObject({
      outcome: "inactive",
    });
    await expect(resumeRecurringRule(f.deps, f.A, f.HA, rate.id)).rejects.toBeInstanceOf(
      ConflictError,
    );

    const ended = await rule({
      description: "Pana in martie",
      frequency: "weekly",
      startOn: "2026-03-02",
      endOn: "2026-03-20",
    });
    const r2 = await generateDueForRule(f.deps, f.A, f.HA, ended.id, "2026-06-01");
    expect(r2).toMatchObject({ generated: 3, status: "completed" });
    expect((await generated(ended.id)).map((x) => x.occurred_on)).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
    ]);
  });

  it("garda 2^53: o generare care ar depăși intervalul JSON al contului e anulată", async () => {
    const big = (
      await createAccount(f.deps, f.A, f.HA, { name: "Mare", type: "bank", currency: "RON" })
    ).id;
    // 900 de sume la plafon (ca superuser, direct): soldul brut ≈ 9·10^15, aproape de 2^53.
    await f.admin`
      insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on)
      select ${f.HA}, ${big}, 'income', 10000000000000, 'RON', date '2026-01-01'
        from generate_series(1, 900)`;
    const r = await rule({
      accountId: big,
      description: "Prea mult",
      amountMinor: 10_000_000_000_000,
      frequency: "daily",
      startOn: "2026-01-01",
    });
    await expect(generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-01-05")).rejects.toBeInstanceOf(
      MoneyOverflowError,
    );
    expect(await generated(r.id)).toHaveLength(0);
    // Prin worker: eșecul e notat (cod fix + pauză de reîncercare), regula iese din fereastră.
    const s = await runDueRecurring(f.deps, "2026-01-05");
    expect(s.errors.amount_out_of_range).toBe(1);
    const view = await getRecurringRule(f.deps, f.A, f.HA, r.id, "2026-01-05");
    expect(view.lastErrorCode).toBe("amount_out_of_range");
    const due = await selectDueRules(f.db, "2026-01-05", 1000);
    expect(due.map((d) => d.ruleId)).not.toContain(r.id);
    await deleteRecurringRule(f.deps, f.A, f.HA, r.id);
  });

  it("contul arhivat: regula trece pe pauză (cod `account_archived`), fără tranzacții", async () => {
    const acc = (
      await createAccount(f.deps, f.A, f.HA, { name: "Vechi", type: "cash", currency: "RON" })
    ).id;
    const r = await rule({
      accountId: acc,
      description: "Pe cont arhivat",
      startOn: "2026-02-01",
      dayOfMonth: 1,
    });
    await archiveAccount(f.deps, f.A, f.HA, acc);
    const res = await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-03-15");
    expect(res).toMatchObject({ outcome: "paused_account_archived", status: "paused" });
    expect((await getRecurringRule(f.deps, f.A, f.HA, r.id)).lastErrorCode).toBe(
      "account_archived",
    );
    await expect(resumeRecurringRule(f.deps, f.A, f.HA, r.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("ștergerea tranzacției generate nu o regenerează; ștergerea regulii păstrează tranzacțiile", async () => {
    const r = await rule({ description: "Stergere", startOn: "2026-01-02", dayOfMonth: 2 });
    await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-02-10");
    const [firstTx] = await f.admin<{ id: string }[]>`
      select id from finet.transactions where recurring_rule_id = ${r.id} order by occurred_on limit 1`;
    await deleteTransaction(f.deps, f.A, f.HA, firstTx!.id);
    const occ = await occurrences(r.id);
    expect(occ).toHaveLength(2);
    expect(occ[0]!.transaction_id).toBeNull();
    // Scadența dată înapoi forțat (ca superuser): ocurența există, deci nu se recreează nimic.
    await f.admin`update finet.recurring_rules set next_run_on = date '2026-01-02' where id = ${r.id}`;
    expect((await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-02-10")).generated).toBe(0);
    expect(await generated(r.id)).toHaveLength(1);

    await deleteRecurringRule(f.deps, f.A, f.HA, r.id);
    const kept = await f.admin`select id from finet.transactions where description = 'Stergere'`;
    expect(kept).toHaveLength(1);
    const linked =
      await f.admin`select 1 from finet.transactions where recurring_rule_id = ${r.id}`;
    expect(linked).toHaveLength(0);
    const audit = await f.admin`
      select action, metadata::text from finet.audit_events where target_id = ${r.id}`;
    expect(audit).toEqual([{ action: "recurring_rule.deleted", metadata: "{}" }]);
  });

  it("modificarea calendarului recalculează scadența de la max(azi, ultima ocurență + 1)", async () => {
    const r = await rule({ description: "Schimbare", startOn: "2026-01-15", dayOfMonth: 15 });
    await generateDueForRule(f.deps, f.A, f.HA, r.id, "2026-02-20");
    const u = await updateRecurringRule(
      f.deps,
      f.A,
      f.HA,
      r.id,
      { frequency: "weekly", dayOfMonth: null },
      "2026-02-20",
    );
    // Grila săptămânală din 15 ian (joi): prima ≥ 20 feb e 26 feb.
    expect(u).toMatchObject({ frequency: "weekly", dayOfMonth: null, nextRunOn: "2026-02-26" });
    await expect(
      updateRecurringRule(f.deps, f.A, f.HA, r.id, { maxOccurrences: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateRecurringRule(f.deps, f.A, f.HA, r.id, { accountId: eur }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateRecurringRule(f.deps, f.A, f.HA, r.id, { status: "completed" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("listare: filtru pe stare și contorul active · de generat · total", async () => {
    const all = await listRecurringRules(f.deps, f.A, f.HA, {}, "2026-10-01");
    expect(all.counts.total).toBe(all.data.length);
    expect(all.counts.active).toBe(all.data.filter((r) => r.status === "active").length);
    expect(all.counts.due).toBe(all.data.filter((r) => r.due).length);
    const paused = await listRecurringRules(f.deps, f.A, f.HA, { status: "paused" }, "2026-10-01");
    expect(paused.data.every((r) => r.status === "paused")).toBe(true);
    expect(paused.counts).toEqual(all.counts);
    await expect(listRecurringRules(f.deps, f.A, f.HA, { status: "x" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("izolare: gospodăria B nu vede, nu modifică, nu generează și nu șterge regulile A (404)", async () => {
    const r = await rule({ description: "Privat A", startOn: "2026-01-03", dayOfMonth: 3 });
    expect((await listRecurringRules(f.deps, f.B, f.HB)).data).toEqual([]);
    for (const call of [
      () => getRecurringRule(f.deps, f.B, f.HB, r.id),
      () => getRecurringRule(f.deps, f.B, f.HA, r.id),
      () => updateRecurringRule(f.deps, f.B, f.HB, r.id, { description: "x" }),
      () => pauseRecurringRule(f.deps, f.B, f.HB, r.id),
      () => resumeRecurringRule(f.deps, f.B, f.HB, r.id),
      () => deleteRecurringRule(f.deps, f.B, f.HB, r.id),
      () => generateDueForRule(f.deps, f.B, f.HB, r.id, "2026-02-01"),
      () => generateDueForRule(f.deps, f.B, f.HA, r.id, "2026-02-01"),
      () => generateDueForHousehold(f.deps, f.B, f.HA, "2026-02-01"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundError);
    }
    // Generarea pentru B nu atinge regulile A.
    const s = await generateDueForHousehold(f.deps, f.B, f.HB, "2026-02-01");
    expect(s.rules).toBe(0);
    // Fără context RLS, finet_app nu vede nicio regulă și nicio ocurență.
    expect(await f.db.execute(sql`select 1 from finet.recurring_rules`)).toHaveLength(0);
    expect(await f.db.execute(sql`select 1 from finet.recurring_occurrences`)).toHaveLength(0);
  });

  it("due_recurring_rules: doar id-uri, doar active și scadente, cu actorul membru; plafoane", async () => {
    const owner = await rule({ description: "Due A", startOn: "2026-01-04", dayOfMonth: 4 });
    const byC = await rule({ description: "Due C", startOn: "2026-01-04", dayOfMonth: 4 }, f.C);
    const future = await rule({ description: "Viitor", startOn: "2998-01-01", dayOfMonth: 1 });
    const paused = await rule({ description: "Pauza", startOn: "2026-01-04", dayOfMonth: 4 });
    await pauseRecurringRule(f.deps, f.A, f.HA, paused.id);

    const cols = await f.db.execute(
      sql`select * from finet.due_recurring_rules(date '2026-01-04', 1000)`,
    );
    expect(Object.keys(cols[0] ?? {}).sort()).toEqual(["actor_user_id", "household_id", "rule_id"]);
    const due = await selectDueRules(f.db, "2026-01-04", 1000);
    const ids = due.map((d) => d.ruleId);
    expect(ids).toContain(owner.id);
    expect(ids).toContain(byC.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(paused.id);
    expect(due.find((d) => d.ruleId === byC.id)!.actorUserId).toBe(f.C.userId);
    expect(due.find((d) => d.ruleId === owner.id)!.actorUserId).toBe(f.A.userId);
    expect(new Set(due.map((d) => d.householdId))).toEqual(new Set([f.HA]));

    // „Azi” plafonat la data reală: o dată din viitor nu arată regulile viitoare.
    const far = await selectDueRules(f.db, "2999-12-31", 1000);
    expect(far.map((d) => d.ruleId)).not.toContain(future.id);
    // Limita: 0..1000 (negativ → 0).
    expect(await selectDueRules(f.db, "2026-01-04", -5)).toEqual([]);
    expect(await selectDueRules(f.db, "2026-01-04", 1)).toHaveLength(1);

    // Creatorul C scos din gospodărie: regula e generată în numele proprietarului A.
    await f.admin`delete from finet.household_members where household_id = ${f.HA} and user_id = ${f.C.userId}`;
    try {
      const after = await selectDueRules(f.db, "2026-01-04", 1000);
      expect(after.find((d) => d.ruleId === byC.id)!.actorUserId).toBe(f.A.userId);
    } finally {
      await f.admin`insert into finet.household_members (household_id, user_id, role)
        values (${f.HA}, ${f.C.userId}, 'member')`;
    }
    for (const r of [owner, byC, future, paused])
      await deleteRecurringRule(f.deps, f.A, f.HA, r.id);
  });

  it("fereastra workerului: o regulă care pică la fiecare rulare nu le blochează pe celelalte (limit=1)", async () => {
    // Regulile anterioare scadente se termină întâi, ca fereastra să conțină doar cele două.
    await runDueRecurring(f.deps, "2026-01-08");
    await runDueRecurring(f.deps, "2026-01-08");
    const broken = await rule({ description: "Stricat", startOn: "2026-01-06", dayOfMonth: 6 });
    const healthy = await rule({ description: "Sanatos", startOn: "2026-01-07", dayOfMonth: 7 });
    await f.admin.unsafe(`
      create function finet.test_fail_broken() returns trigger language plpgsql as $$
      begin
        if new.description = 'Stricat' then raise exception 'stricat' using errcode = 'P0001'; end if;
        return new;
      end $$;
      create trigger test_fail_broken before insert on finet.transactions
        for each row execute function finet.test_fail_broken();`);
    try {
      const first = await runDueRecurring(f.deps, "2026-01-08", 1);
      expect(first).toMatchObject({ rules: 1, failed: 1, generated: 0 });
      const second = await runDueRecurring(f.deps, "2026-01-08", 1);
      expect(second).toMatchObject({ rules: 1, failed: 0, generated: 1 });
      expect(await generated(healthy.id)).toHaveLength(1);
      expect((await getRecurringRule(f.deps, f.A, f.HA, broken.id)).lastErrorCode).toBe(
        "generation_failed",
      );
    } finally {
      await f.admin.unsafe(`drop trigger test_fail_broken on finet.transactions;
        drop function finet.test_fail_broken();`);
    }
  });

  it("drepturi: funcția nu e executabilă de anon/authenticated/PUBLIC; finet_app nu schimbă câmpurile fixe", async () => {
    const [p] = await f.admin<{ anon: boolean; auth: boolean; app: boolean; pub: boolean }[]>`
      select has_function_privilege('anon', 'finet.due_recurring_rules(date, integer)', 'execute') as anon,
             has_function_privilege('authenticated', 'finet.due_recurring_rules(date, integer)', 'execute') as auth,
             has_function_privilege('finet_app', 'finet.due_recurring_rules(date, integer)', 'execute') as app,
             exists (select 1 from pg_proc pr, aclexplode(pr.proacl) a
                      where pr.proname = 'due_recurring_rules' and a.grantee = 0) as pub`;
    expect(p).toEqual({ anon: false, auth: false, app: true, pub: false });
    const [def] = await f.admin<{ secdef: boolean; owner: string; config: string[] }[]>`
      select prosecdef as secdef, pg_get_userbyid(proowner) as owner, proconfig as config
        from pg_proc where proname = 'due_recurring_rules'`;
    expect(def).toEqual({
      secdef: true,
      owner: "finet_migrator",
      config: ["search_path=pg_catalog"],
    });
  });
});
