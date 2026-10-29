import { createHash, randomUUID } from "node:crypto";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { sqlState } from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const TABLES = ["receipt_match_rejections", "recurring_suggestion_dismissals", "statement_uploads"];
const sha = (c: string) => c.repeat(64);

/**
 * 0014_statement_uploads ca `finet_app` (ADR 0018 §11, ADR 0019): vizibilitatea încărcărilor,
 * respingerilor și propunerilor urmează contul (personal ⇒ doar proprietarul); tranzițiile de
 * stare ale încărcărilor; ștergerea doar fără fișier; funcțiile SECURITY DEFINER întorc doar
 * identificatori; contorul zilnic nu scade; bonul se leagă doar de o cheltuială vizibilă, o
 * tranzacție are cel mult un bon.
 */
describe.skipIf(!TEST_ADMIN_URL)("0014: încărcări de extrase, respingeri (finet_app)", () => {
  let f: FamilyFixture;
  let common: string;
  let personalC: string;
  let txCommon: string;
  let txPersonal: string;
  const as = (userId: string, householdId: string | null, statement: SQL) =>
    withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));
  const key = (hh: string) => `households/${hh}/documents/${randomUUID()}`;
  const newUpload = (user: string, account: string, over: { c?: string; expires?: SQL } = {}) => {
    const id = randomUUID();
    return {
      id,
      run: () =>
        as(
          user,
          f.HA,
          sql`insert into finet.statement_uploads (id, household_id, account_id, currency,
                created_by_user_id, storage_key, sha256, size_bytes, expires_at)
              values (${id}, ${f.HA}, ${account}, 'RON', ${user}, ${key(f.HA)},
                ${over.c ? sha(over.c) : createHash("sha256").update(id).digest("hex")}, 100,
                ${over.expires ?? sql`now() + interval '1 day'`})`,
        ),
    };
  };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_stmtup");
    const mk = async (actor: typeof f.A, name: string, owner?: string) =>
      (
        await createAccount(f.deps, actor, f.HA, {
          name,
          type: "bank",
          currency: "RON",
          ...(owner ? { ownerUserId: owner } : {}),
        })
      ).id;
    common = await mk(f.A, "Comun");
    personalC = await mk(f.C, "Al lui C", f.C.userId);
    const tx = async (actor: typeof f.A, accountId: string) =>
      (
        await createTransaction(f.deps, actor, f.HA, {
          accountId,
          type: "expense",
          amountMinor: 100,
          occurredOn: "2026-11-03",
        })
      ).id;
    txCommon = await tx(f.A, common);
    txPersonal = await tx(f.C, personalC);
  });
  afterAll(async () => {
    await f?.close();
  });

  it("RLS ENABLE + FORCE; drepturi minime (fără UPDATE pe tabel); nimic pentru PUBLIC/anon", async () => {
    const rows = await f.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' and c.relname = any(${TABLES})
       order by c.relname`;
    expect(rows).toEqual(TABLES.map((relname) => ({ relname, on: true, force: true })));
    const table = await f.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee = 'finet_app' and table_name = any(${TABLES})
       order by 1, 2`;
    expect(table.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
      "receipt_match_rejections:DELETE",
      "receipt_match_rejections:INSERT",
      "receipt_match_rejections:SELECT",
      "recurring_suggestion_dismissals:DELETE",
      "recurring_suggestion_dismissals:INSERT",
      "recurring_suggestion_dismissals:SELECT",
      "statement_uploads:DELETE",
      "statement_uploads:INSERT",
      "statement_uploads:SELECT",
    ]);
    const cols = await f.admin<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name = 'statement_uploads' order by 1`;
    expect(cols.map((r) => r.column_name)).toEqual([
      "attempts",
      "error_code",
      "file_deleted_at",
      "import_id",
      "processing_started_at",
      "status",
      "storage_key",
      "updated_at",
    ]);
    const pub = await f.admin`
      select grantee from information_schema.role_table_grants
       where table_schema = 'finet' and table_name = any(${TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(pub).toEqual([]);
    const fns = await f.admin<{ proname: string; acl: string }[]>`
      select p.proname, coalesce(p.proacl::text, '') as acl from pg_proc p
       where p.pronamespace = 'finet'::regnamespace and p.prosecdef
         and p.proname like any (array['%statement_upload%', 'purge_stale_statement_previews'])
       order by 1`;
    expect(fns.map((r) => r.proname)).toEqual([
      "cleanable_statement_uploads",
      "forget_statement_upload_file",
      "purge_stale_statement_previews",
      "queued_statement_upload",
      "queued_statement_uploads",
    ]);
    for (const fn of fns) expect(fn.acl).not.toMatch(/(^|[{,])=X/);
  });

  it("încărcarea pe un cont PERSONAL o vede doar proprietarul; inserarea doar pe conturi vizibile, ca autor", async () => {
    const mine = newUpload(f.C.userId, personalC);
    await mine.run();
    const seen = (user: string) =>
      as(user, f.HA, sql`select id from finet.statement_uploads where id = ${mine.id}`);
    expect(await seen(f.C.userId)).toHaveLength(1);
    expect(await seen(f.A.userId)).toHaveLength(0);
    // A nu poate încărca pe contul personal al lui C și nu poate încărca în numele lui C.
    expect(await sqlState(() => newUpload(f.A.userId, personalC).run())).toBe("42501");
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.statement_uploads (household_id, account_id, currency,
                created_by_user_id, storage_key, sha256, size_bytes, expires_at)
              values (${f.HA}, ${common}, 'RON', ${f.C.userId}, ${key(f.HA)}, ${sha("e")}, 1,
                now() + interval '1 day')`,
        ),
      ),
    ).toBe("42501");
    // Starea inițială e impusă: nu se poate insera direct `parsed`.
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.statement_uploads (household_id, account_id, currency,
                created_by_user_id, storage_key, sha256, size_bytes, expires_at, status)
              values (${f.HA}, ${common}, 'RON', ${f.A.userId}, ${key(f.HA)}, ${sha("f")}, 1,
                now() + interval '1 day', 'parsed')`,
        ),
      ),
    ).toBe("42501");
    // Altă gospodărie: invizibil.
    expect(
      await as(f.B.userId, f.HB, sql`select id from finet.statement_uploads where id = ${mine.id}`),
    ).toHaveLength(0);
  });

  it("tranzițiile: queued → processing → parsed (finală); încercările nu scad; cheia doar se golește", async () => {
    const u = newUpload(f.A.userId, common);
    await u.run();
    const upd = (set: SQL) =>
      sqlState(() =>
        as(f.A.userId, f.HA, sql`update finet.statement_uploads set ${set} where id = ${u.id}`),
      );
    expect(await upd(sql`status = 'parsed'`)).toBe("23514");
    expect(await upd(sql`status = 'processing', attempts = 1`)).toBeNull();
    expect(await upd(sql`attempts = 0`)).toBe("23514");
    expect(await upd(sql`status = 'queued'`)).toBe("23514");
    expect(await upd(sql`storage_key = ${key(f.HA)}`)).toBe("23514");
    expect(await upd(sql`status = 'parsed'`)).toBeNull();
    expect(await upd(sql`status = 'failed'`)).toBe("23514");
    // Coloanele fără drept de UPDATE (contul, amprenta, autorul).
    expect(await upd(sql`account_id = ${personalC}`)).toBe("42501");
    expect(await upd(sql`sha256 = ${sha("9")}`)).toBe("42501");
    // Ștergerea: doar după golirea cheii (fișierul șters întâi).
    expect(
      await as(f.A.userId, f.HA, sql`delete from finet.statement_uploads where id = ${u.id}`),
    ).toHaveLength(0);
    expect(
      await upd(sql`storage_key = null, file_deleted_at = now(), updated_at = now()`),
    ).toBeNull();
    await as(f.A.userId, f.HA, sql`delete from finet.statement_uploads where id = ${u.id}`);
    expect(await f.admin`select 1 from finet.statement_uploads where id = ${u.id}`).toHaveLength(0);
  });

  it("legătura spre previzualizare: doar pe același cont, o singură dată, odată cu `parsed`", async () => {
    const u = newUpload(f.A.userId, common);
    await u.run();
    const imp = randomUUID();
    const other = randomUUID();
    for (const [id, account, c] of [
      [imp, common, "1"],
      [other, personalC, "2"],
    ] as const) {
      await f.admin`insert into finet.statement_imports (id, household_id, account_id, currency,
          created_by_user_id, bank, format, parser_version, balance_status, source_sha256)
        values (${id}, ${f.HA}, ${account}, 'RON', ${f.C.userId}, 'bt', 'pdf', 1, 'ok', ${sha(c)})`;
    }
    const upd = (set: SQL) =>
      sqlState(() =>
        as(f.A.userId, f.HA, sql`update finet.statement_uploads set ${set} where id = ${u.id}`),
      );
    await upd(sql`status = 'processing', attempts = 1`);
    // Previzualizarea altui cont (personal al lui C): cheia compusă o refuză.
    expect(await upd(sql`status = 'parsed', import_id = ${other}`)).toBe("23503");
    // Fără `parsed`: refuzat.
    expect(await upd(sql`import_id = ${imp}`)).toBe("23514");
    expect(await upd(sql`status = 'parsed', import_id = ${imp}`)).toBeNull();
    expect(await upd(sql`import_id = null`)).toBe("23514");
    // Ștergerea previzualizării desface legătura (ON DELETE SET NULL).
    await f.admin`delete from finet.statement_imports where id = ${imp}`;
    const [row] = await f.admin<{ import_id: string | null; status: string }[]>`
      select import_id, status from finet.statement_uploads where id = ${u.id}`;
    expect(row).toEqual({ import_id: null, status: "parsed" });
    await f.admin`delete from finet.statement_imports where id = ${other}`;
  });

  it("funcțiile SECURITY DEFINER: coada (autorul activ), curățarea (doar expirate/eșuate) și golirea cheii", async () => {
    await f.admin`delete from finet.statement_uploads`;
    const live = newUpload(f.A.userId, common);
    await live.run();
    const old = newUpload(f.C.userId, personalC);
    await old.run();
    await f.admin`update finet.statement_uploads set created_at = now() - interval '2 days',
                    expires_at = now() - interval '1 day' where id = ${old.id}`;
    const app = (q: SQL) => as(f.A.userId, f.HA, q);
    const queued = await app(
      sql`select upload_id, household_id, actor_user_id from finet.queued_statement_uploads(10, 900)`,
    );
    expect(queued).toEqual([{ upload_id: live.id, household_id: f.HA, actor_user_id: f.A.userId }]);
    expect(
      await app(sql`select upload_id from finet.queued_statement_upload(${old.id})`),
    ).toHaveLength(0);
    const cleanable = (await app(
      sql`select upload_id, household_id, storage_key from finet.cleanable_statement_uploads(10)`,
    )) as unknown as { upload_id: string; storage_key: string }[];
    expect(cleanable.map((r) => r.upload_id)).toEqual([old.id]);
    // Cheia greșită nu golește nimic; cea corectă golește și marchează `upload_expired`.
    expect(
      await app(sql`select finet.forget_statement_upload_file(${old.id}, ${key(f.HA)}) as ok`),
    ).toEqual([{ ok: false }]);
    expect(
      await app(
        sql`select finet.forget_statement_upload_file(${old.id}, ${cleanable[0]!.storage_key}) as ok`,
      ),
    ).toEqual([{ ok: true }]);
    expect(
      await app(sql`select finet.forget_statement_upload_file(${live.id}, ${"x"}) as ok`),
    ).toEqual([{ ok: false }]);
    const [row] = await f.admin<{ status: string; code: string | null; key: string | null }[]>`
      select status, error_code as code, storage_key as key from finet.statement_uploads
       where id = ${old.id}`;
    expect(row).toEqual({ status: "failed", code: "upload_expired", key: null });
    // Un autor care nu mai e membru: încărcarea nu intră în coadă (fără actor), dar se curăță.
    const gone = await f.newUser("Plecat");
    await f.addMember(f.A, f.HA, gone);
    const g = newUpload(gone.userId, common);
    await g.run();
    await f.admin`delete from finet.household_members where user_id = ${gone.userId}`;
    expect(await app(sql`select upload_id from finet.queued_statement_uploads(10, 900)`)).toEqual([
      { upload_id: live.id },
    ]);
  });

  it("previzualizările neconfirmate mai vechi de 7 zile se șterg (minimum 7 zile, oricare ar fi parametrul)", async () => {
    const recent = randomUUID();
    const stale = randomUUID();
    const done = randomUUID();
    for (const [id, c, status, age] of [
      [recent, "3", "previewed", "1 day"],
      [stale, "4", "previewed", "9 days"],
      [done, "5", "imported", "30 days"],
    ] as const) {
      await f.admin`insert into finet.statement_imports (id, household_id, account_id, currency,
          created_by_user_id, bank, format, parser_version, balance_status, source_sha256, status,
          imported_at, created_at)
        values (${id}, ${f.HA}, ${common}, 'RON', ${f.A.userId}, 'bt', 'pdf', 1, 'ok', ${sha(c)},
          ${status}, case when ${status}::text = 'imported' then now() end,
          now() - ${age}::interval)`;
    }
    const [r] = (await as(
      f.A.userId,
      f.HA,
      sql`select finet.purge_stale_statement_previews(0, 100) as n`,
    )) as unknown as { n: number }[];
    expect(r!.n).toBe(1);
    const left = await f.admin<{ id: string }[]>`
      select id from finet.statement_imports where id = any(${[recent, stale, done]}) order by id`;
    expect(left.map((x) => x.id).sort()).toEqual([recent, done].sort());
  });

  it("cota zilnică a extraselor nu scade (trigger), nici prin UPDATE direct", async () => {
    await as(
      f.A.userId,
      f.HA,
      sql`insert into finet.statement_usage_daily (household_id, day, count) values (${f.HA}, '2026-11-01', 5)`,
    );
    const upd = (n: number) =>
      sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.statement_usage_daily set count = ${n}
               where household_id = ${f.HA} and day = '2026-11-01'`,
        ),
      );
    expect(await upd(4)).toBe("23514");
    expect(await upd(6)).toBeNull();
  });

  it("bonul se leagă doar de o cheltuială VIZIBILĂ; o tranzacție are cel mult un bon", async () => {
    const doc = async () => {
      const id = randomUUID();
      await f.admin`insert into finet.documents (id, household_id, kind, status, detected_mime,
          size_bytes, sha256, storage_key, uploaded_by_user_id)
        values (${id}, ${f.HA}, 'receipt', 'done', 'image/jpeg', 10,
          ${createHash("sha256").update(id).digest("hex")},
          ${`households/${f.HA}/documents/${id}`}, ${f.A.userId})`;
      const r = randomUUID();
      await f.admin`insert into finet.receipts (id, household_id, document_id, status, total_minor)
        values (${r}, ${f.HA}, ${id}, 'needs_review', 100)`;
      return r;
    };
    const r1 = await doc();
    const r2 = await doc();
    const link = (user: string, r: string, t: string) =>
      sqlState(() =>
        as(user, f.HA, sql`update finet.receipts set transaction_id = ${t} where id = ${r}`),
      );
    // A nu vede tranzacția din contul personal al lui C.
    expect(await link(f.A.userId, r1, txPersonal)).toBe("23503");
    expect(await link(f.A.userId, r1, txCommon)).toBeNull();
    expect(await link(f.A.userId, r2, txCommon)).toBe("23505");
    expect(await link(f.C.userId, r2, txPersonal)).toBeNull();
  });

  it("respingerile potrivirilor și ale propunerilor: vizibile doar cu tranzacția / contul", async () => {
    const [r] = await f.admin<{ id: string }[]>`
      select id from finet.receipts where household_id = ${f.HA} limit 1`;
    const reject = (user: string, t: string) =>
      sqlState(() =>
        as(
          user,
          f.HA,
          sql`insert into finet.receipt_match_rejections (household_id, receipt_id, transaction_id,
                rejected_by_user_id) values (${f.HA}, ${r!.id}, ${t}, ${user})`,
        ),
      );
    expect(await reject(f.A.userId, txPersonal)).toBe("42501");
    expect(await reject(f.C.userId, txPersonal)).toBeNull();
    expect(
      await as(f.A.userId, f.HA, sql`select 1 from finet.receipt_match_rejections`),
    ).toHaveLength(0);
    expect(
      await as(f.C.userId, f.HA, sql`select 1 from finet.receipt_match_rejections`),
    ).toHaveLength(1);
    const dismiss = (user: string, account: string) =>
      sqlState(() =>
        as(
          user,
          f.HA,
          sql`insert into finet.recurring_suggestion_dismissals (household_id, account_id, currency,
                signature, dismissed_by_user_id)
              values (${f.HA}, ${account}, 'RON', ${createHash("sha256").update(randomUUID()).digest("hex")}, ${user})`,
        ),
      );
    expect(await dismiss(f.A.userId, personalC)).toBe("42501");
    expect(await dismiss(f.C.userId, personalC)).toBeNull();
    expect(
      await as(f.A.userId, f.HA, sql`select 1 from finet.recurring_suggestion_dismissals`),
    ).toHaveLength(0);
    // UPDATE nu e permis deloc.
    expect(
      await sqlState(() =>
        as(
          f.C.userId,
          f.HA,
          sql`update finet.recurring_suggestion_dismissals set signature = ${sha("0")}`,
        ),
      ),
    ).toBe("42501");
  });
});
