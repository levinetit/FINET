import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@/lib/authz";
import { ConflictError } from "@/lib/errors";
import { createAccount, listAccounts } from "@/modules/accounts/accounts.service";
import { createBudget, getBudgetStatuses } from "@/modules/budgets/budgets.service";
import { getDashboard } from "@/modules/dashboard/dashboard.service";
import { collectCsv, exportTransactionsCsv } from "@/modules/exports/exports.service";
import { leaveHousehold } from "@/modules/family/members.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { sqlState, systemCategoryId } from "@/modules/ledger/testing";
import { createRecurringRule, listRecurringRules } from "@/modules/recurring/recurring.service";
import { selectDueRules } from "@/modules/recurring/recurring.repo";
import { getMonthlyReport } from "@/modules/reports/reports.service";
import { createTag, getTransactionTagIds } from "@/modules/tags/tags.service";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
} from "@/modules/transactions/transactions.service";
import { createTransfer, getTransfer } from "@/modules/transfers/transfers.service";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** Tabelele Fazei 8 (0012_family.sql). */
const FAMILY_TABLES = ["household_invites", "settlements", "transaction_splits"];

/**
 * Vizibilitatea PERSONAL / COMUN impusă în bază (0012) și efectul ei pe TOATE modulele care
 * citesc tranzacții: conturi, tranzacții, transferuri, etichete, bugete, dashboard, rapoarte,
 * exporturi, reguli recurente. C (member în HA) are un cont personal; A (owner în HA) nu vede
 * nimic din el, nici în agregate. Plus RLS + drepturile pe tabelele noi.
 */
describe.skipIf(!TEST_ADMIN_URL)(
  "familia: vizibilitate personal/comun și drepturi (finet_app)",
  () => {
    let f: FamilyFixture;
    let common: string;
    let personalC: string;
    let txCommon: string;
    let txPersonal: string;
    let groceries: string;
    const day = "2026-10-15";
    const deps = () => ({ db: f.db, now: () => new Date("2026-10-20T10:00:00Z") });
    const as = (userId: string, householdId: string | null, statement: SQL) =>
      withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));

    beforeAll(async () => {
      f = await createFamilyFixture("finet_it_famrls");
      groceries = await systemCategoryId(f.admin, "expense.groceries");
      common = (
        await createAccount(f.deps, f.A, f.HA, { name: "Comun", type: "bank", currency: "RON" })
      ).id;
      personalC = (
        await createAccount(f.deps, f.C, f.HA, {
          name: "Cardul lui C",
          type: "cash",
          currency: "RON",
          ownerUserId: f.C.userId,
        })
      ).id;
      txCommon = (
        await createTransaction(f.deps, f.A, f.HA, {
          accountId: common,
          type: "expense",
          amountMinor: 1_000,
          occurredOn: day,
          categoryId: groceries,
          merchant: "Piața",
        })
      ).id;
      txPersonal = (
        await createTransaction(f.deps, f.C, f.HA, {
          accountId: personalC,
          type: "expense",
          amountMinor: 7_777,
          occurredOn: day,
          categoryId: groceries,
          merchant: "Secret SRL",
          description: "Cadou surpriză",
        })
      ).id;
    });
    afterAll(async () => {
      await f?.close();
    });

    it("RLS ENABLE + FORCE pe tabelele noi; fără context: niciun rând; nimic pentru anon/authenticated", async () => {
      const rows = await f.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' and c.relname = any(${FAMILY_TABLES})
       order by c.relname`;
      expect(rows).toEqual(FAMILY_TABLES.map((relname) => ({ relname, on: true, force: true })));
      for (const table of ["transaction_splits", "settlements"]) {
        expect(await f.fx.client.unsafe(`select * from finet.${table}`), table).toHaveLength(0);
      }
      expect(await f.fx.client.unsafe(`select id from finet.household_invites`)).toHaveLength(0);
      const grants = await f.admin`
      select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'finet' and table_name = any(${FAMILY_TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
      expect(grants).toEqual([]);
    });

    it("drepturi pe coloane: hash-ul tokenului necitibil, fără DELETE pe invitații/decontări, fără UPDATE pe împărțiri, membrii doar `role`", async () => {
      const privileges = await f.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee = 'finet_app' and table_name = any(${FAMILY_TABLES})
       order by table_name, privilege_type`;
      expect(privileges).toEqual(
        [
          { table_name: "transaction_splits", privilege_type: "DELETE" },
          { table_name: "transaction_splits", privilege_type: "INSERT" },
          { table_name: "transaction_splits", privilege_type: "SELECT" },
          { table_name: "settlements", privilege_type: "SELECT" },
        ].sort((a, b) =>
          a.table_name === b.table_name
            ? a.privilege_type.localeCompare(b.privilege_type)
            : a.table_name.localeCompare(b.table_name),
        ),
      );
      const cols = await f.admin<
        { table_name: string; column_name: string; privilege_type: string }[]
      >`
      select table_name, column_name, privilege_type from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app'
         and privilege_type in ('SELECT', 'UPDATE')
         and table_name in ('household_invites', 'household_members')
       order by table_name, privilege_type, column_name`;
      const of = (t: string, p: string) =>
        cols.filter((c) => c.table_name === t && c.privilege_type === p).map((c) => c.column_name);
      expect(of("household_invites", "SELECT")).not.toContain("token_hash");
      expect(of("household_invites", "UPDATE")).toEqual(["revoked_at"]);
      expect(of("household_members", "UPDATE")).toEqual(["role"]);
      expect(
        await sqlState(() =>
          as(f.A.userId, f.HA, sql`select token_hash from finet.household_invites`),
        ),
      ).toBe("42501");
      expect(
        await sqlState(() => as(f.A.userId, f.HA, sql`delete from finet.household_invites`)),
      ).toBe("42501");
      expect(
        await sqlState(() =>
          as(
            f.A.userId,
            f.HA,
            sql`update finet.household_members set joined_at = now() where user_id = ${f.A.userId}`,
          ),
        ),
      ).toBe("42501");
      // Un membru nu-și poate crea singur o invitație (doar owner) și nu poate citi invitațiile.
      expect(
        await sqlState(() =>
          as(
            f.C.userId,
            f.HA,
            sql`insert into finet.household_invites (household_id, token_hash, role, created_by_user_id, expires_at)
              values (${f.HA}, ${"c".repeat(64)}, 'owner', ${f.C.userId}, now() + interval '1 hour')`,
          ),
        ),
      ).toBe("42501");
      // accept_invite: doar identificatori; executabilă de finet_app, nu de PUBLIC.
      const [fn] = await f.admin<{ definer: boolean; config: string[] }[]>`
      select prosecdef as definer, proconfig as config from pg_proc
       where proname = 'accept_invite' and pronamespace = 'finet'::regnamespace`;
      expect(fn).toEqual({ definer: true, config: ["search_path=pg_catalog"] });
      const [pub] = await f.admin<{ ok: boolean }[]>`
      select has_function_privilege('public', 'finet.accept_invite(text)', 'execute') as ok`;
      expect(pub?.ok).toBe(false);
    });

    it("conturi: A nu vede contul personal al lui C (listă, sume, totaluri); C îl vede", async () => {
      const asA = await listAccounts(f.deps, f.A, f.HA);
      expect(asA.accounts.map((a) => a.id)).toEqual([common]);
      expect(
        JSON.stringify(asA.totals, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ).not.toContain("7777");
      const asC = await listAccounts(f.deps, f.C, f.HA);
      expect(asC.accounts.map((a) => a.id).sort()).toEqual([common, personalC].sort());
    });

    it("tranzacții: A nu vede, nu modifică, nu șterge și nu adaugă în contul personal al lui C", async () => {
      expect((await listTransactions(f.deps, f.A, f.HA)).data.map((t) => t.id)).toEqual([txCommon]);
      await expect(getTransaction(f.deps, f.A, f.HA, txPersonal)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(deleteTransaction(f.deps, f.A, f.HA, txPersonal)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        createTransaction(f.deps, f.A, f.HA, {
          accountId: personalC,
          type: "expense",
          amountMinor: 1,
          occurredOn: day,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Direct în bază: rândul nu există pentru A (0 rânduri), inserarea e refuzată.
      const rows = await as(
        f.A.userId,
        f.HA,
        sql`select id from finet.transactions where id = ${txPersonal}`,
      );
      expect(rows).toHaveLength(0);
      const upd = await as(
        f.A.userId,
        f.HA,
        sql`update finet.transactions set notes = 'x' where id = ${txPersonal} returning id`,
      );
      expect(upd).toHaveLength(0);
      expect(
        await sqlState(() =>
          as(
            f.A.userId,
            f.HA,
            sql`insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on)
              values (${f.HA}, ${personalC}, 'expense', 1, 'RON', ${day})`,
          ),
        ),
      ).toMatch(/^(42501|23503)$/);
      expect((await listTransactions(f.deps, f.C, f.HA)).data.map((t) => t.id).sort()).toEqual(
        [txCommon, txPersonal].sort(),
      );
    });

    it("agregatele respectă regula: dashboard, raport lunar, buget comun, export CSV", async () => {
      const dashA = await getDashboard(deps(), f.A, f.HA, { month: "2026-10" });
      const dashC = await getDashboard(deps(), f.C, f.HA, { month: "2026-10" });
      expect(dashA.currencies[0]!.totals.expenseMinor).toBe(1_000n);
      expect(dashC.currencies[0]!.totals.expenseMinor).toBe(8_777n);
      const repA = await getMonthlyReport(deps(), f.A, f.HA, { month: "2026-10" });
      expect(repA.currencies[0]!.totals.expenseMinor).toBe(1_000n);
      expect(repA.currencies[0]!.topMerchants.map((m) => m.merchant)).not.toContain("Secret SRL");
      await createBudget(deps(), f.A, f.HA, { amountMinor: 100_000, currency: "RON" });
      const statusA = (await getBudgetStatuses(deps(), f.A, f.HA, { month: "2026-10" }))[0]!;
      const statusC = (await getBudgetStatuses(deps(), f.C, f.HA, { month: "2026-10" }))[0]!;
      expect(statusA.spentMinor).toBe(1_000n);
      expect(statusC.spentMinor).toBe(8_777n);
      const csvA = await collectCsv(exportTransactionsCsv(deps(), f.A, f.HA));
      expect(csvA).toContain("Piața");
      expect(csvA).not.toContain("Secret SRL");
      expect(csvA).not.toContain("Cadou");
      const csvC = await collectCsv(exportTransactionsCsv(deps(), f.C, f.HA));
      expect(csvC).toContain("Secret SRL");
    });

    it("etichetele tranzacțiilor personale sunt invizibile altora (și nu se pot atașa)", async () => {
      const tag = await createTag(f.deps, f.C, f.HA, { name: "Privat C" });
      await withRlsOn(f.db, { userId: f.C.userId, householdId: f.HA }, (tx) =>
        tx.execute(sql`insert into finet.transaction_tags (transaction_id, tag_id, household_id)
                     values (${txPersonal}, ${tag.id}, ${f.HA})`),
      );
      expect(await getTransactionTagIds(f.deps, f.C, f.HA, txPersonal)).toEqual([tag.id]);
      expect(
        await as(
          f.A.userId,
          f.HA,
          sql`select * from finet.transaction_tags where transaction_id = ${txPersonal}`,
        ),
      ).toHaveLength(0);
      expect(
        await sqlState(() =>
          as(
            f.A.userId,
            f.HA,
            sql`insert into finet.transaction_tags (transaction_id, tag_id, household_id)
              values (${txPersonal}, ${tag.id}, ${f.HA})`,
          ),
        ),
      ).toMatch(/^(42501|23505)$/);
    });

    it("transfer personal → comun: A vede doar jumătatea comună și NU poate rupe grupul", async () => {
      const t = await createTransfer(f.deps, f.C, f.HA, {
        fromAccountId: personalC,
        toAccountId: common,
        amountMinor: 500,
        occurredOn: day,
      });
      // A: grupul incomplet nu e un transfer vizibil (404), iar ștergerea jumătății comune eșuează
      // la COMMIT (verificarea grupului vede ambele rânduri).
      await expect(getTransfer(f.deps, f.A, f.HA, t.id)).rejects.toBeInstanceOf(NotFoundError);
      const visibleLeg = (await listTransactions(f.deps, f.A, f.HA, { type: "transfer" })).data;
      expect(visibleLeg).toHaveLength(1);
      expect(visibleLeg[0]!.accountId).toBe(common);
      const err = await deleteTransaction(f.deps, f.A, f.HA, visibleLeg[0]!.id).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where transfer_group_id = ${t.id}`;
      expect(n?.n).toBe(2);
      // C (vede ambele): transferul e întreg.
      expect((await getTransfer(f.deps, f.C, f.HA, t.id)).id).toBe(t.id);
    });

    it("regulile recurente pe contul personal: invizibile altora; generate în numele proprietarului; omise după plecarea lui", async () => {
      const rule = await createRecurringRule(
        f.deps,
        f.C,
        f.HA,
        {
          accountId: personalC,
          type: "expense",
          amountMinor: 1_500,
          description: "Abonament C",
          frequency: "monthly",
          startOn: "2026-10-01",
        },
        "2026-10-20",
      );
      expect((await listRecurringRules(f.deps, f.A, f.HA)).data.map((r) => r.id)).not.toContain(
        rule.id,
      );
      expect((await listRecurringRules(f.deps, f.C, f.HA)).data.map((r) => r.id)).toContain(
        rule.id,
      );
      await expect(
        createRecurringRule(
          f.deps,
          f.A,
          f.HA,
          {
            accountId: personalC,
            type: "expense",
            amountMinor: 1,
            description: "Furat",
            frequency: "monthly",
            startOn: "2026-10-01",
          },
          "2026-10-20",
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const due = (await selectDueRules(f.db, "2999-01-01", 100)).filter(
        (d) => d.ruleId === rule.id,
      );
      expect(due).toEqual([{ ruleId: rule.id, householdId: f.HA, actorUserId: f.C.userId }]);
      // C pleacă (fără solduri): conturile lui personale rămân în gospodărie, invizibile tuturor,
      // iar regula nu mai e selectată (nu mai eșuează în numele unui owner care nu vede contul).
      await leaveHousehold(f.deps, f.C, f.HA);
      expect((await selectDueRules(f.db, "2999-01-01", 100)).map((d) => d.ruleId)).not.toContain(
        rule.id,
      );
      expect((await listAccounts(f.deps, f.A, f.HA)).accounts.map((a) => a.id)).not.toContain(
        personalC,
      );
      const [kept] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id = ${personalC}`;
      expect(kept?.n).toBeGreaterThan(0);
    });
  },
);
