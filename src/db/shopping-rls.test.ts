import { randomUUID } from "node:crypto";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { sqlState } from "@/modules/ledger/testing";
import { upsertAiRequest } from "@/modules/shopping/shopping.repo";
import { grantExternalAi, seedReceipt } from "@/modules/shopping/testing";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const TABLES = ["shopping_list_ai_requests", "shopping_list_items", "shopping_lists"];

/**
 * 0017_shopping_lists ca `finet_app` (ADR 0022): RLS ENABLE + FORCE, drepturi minime pe coloane,
 * vizibilitatea personal/comun, cheile compuse cu gospodăria, `SET NULL` doar pe coloana liniei,
 * CHECK-urile, plafoanele, coada AI și funcțiile SECURITY DEFINER (doar identificatori).
 */
describe.skipIf(!TEST_ADMIN_URL)("0017: liste de cumpărături (finet_app)", () => {
  let f: FamilyFixture;
  const as = (userId: string, householdId: string | null, statement: SQL) =>
    withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));
  const rows = async <T>(userId: string, householdId: string | null, statement: SQL) =>
    (await as(userId, householdId, statement)) as unknown as T[];

  async function newList(
    owner: string,
    hh: string,
    personal: boolean,
    name = "L",
  ): Promise<string> {
    const id = randomUUID();
    await as(
      owner,
      hh,
      sql`insert into finet.shopping_lists (id, household_id, name, owner_user_id, created_by_user_id)
          values (${id}, ${hh}, ${name}, ${personal ? owner : null}, ${owner})`,
    );
    return id;
  }
  async function newItem(owner: string, hh: string, list: string, name = "lapte"): Promise<string> {
    const id = randomUUID();
    await as(
      owner,
      hh,
      sql`insert into finet.shopping_list_items (id, list_id, household_id, name, normalized_name)
          values (${id}, ${list}, ${hh}, ${name}, ${name})`,
    );
    return id;
  }

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_shoprls");
  });
  afterAll(async () => {
    await f?.close();
  });

  it("RLS ENABLE + FORCE; drepturi minime; nimic pentru PUBLIC/anon/authenticated", async () => {
    const r = await f.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' and c.relname = any(${TABLES})
       order by c.relname`;
    expect(r).toEqual(TABLES.map((relname) => ({ relname, on: true, force: true })));
    const table = await f.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee = 'finet_app' and table_name = any(${TABLES})
       order by 1, 2`;
    expect(table.map((x) => `${x.table_name}:${x.privilege_type}`)).toEqual([
      "shopping_list_ai_requests:INSERT",
      "shopping_list_ai_requests:SELECT",
      "shopping_list_items:DELETE",
      "shopping_list_items:INSERT",
      "shopping_list_items:SELECT",
      "shopping_lists:DELETE",
      "shopping_lists:INSERT",
      "shopping_lists:SELECT",
    ]);
    const cols = await f.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name = any(${TABLES}) order by 1, 2`;
    const byTable = (t: string) => cols.filter((c) => c.table_name === t).map((c) => c.column_name);
    expect(byTable("shopping_lists")).toEqual(["name", "owner_user_id", "status", "updated_at"]);
    // `household_id`, `list_id`, `id`, `created_at` nu se schimbă niciodată.
    expect(byTable("shopping_list_items")).not.toContain("household_id");
    expect(byTable("shopping_list_items")).not.toContain("list_id");
    expect(byTable("shopping_list_items")).toContain("checked");
    expect(byTable("shopping_list_ai_requests")).not.toContain("list_id");
    expect(byTable("shopping_list_ai_requests")).not.toContain("receipt_id");
    for (const role of ["anon", "authenticated", "public"]) {
      const g = await f.admin<{ n: number }[]>`
        select count(*)::int as n from information_schema.role_table_grants
         where table_schema = 'finet' and grantee = ${role} and table_name = any(${TABLES})`;
      expect(g[0]!.n).toBe(0);
    }
    // Fără context RLS, finet_app nu vede nimic.
    const l = await newList(f.A.userId, f.HA, false);
    expect(await rows(f.A.userId, null, sql`select id from finet.shopping_lists`)).toEqual([]);
    expect(
      (await rows<{ id: string }>(f.A.userId, f.HA, sql`select id from finet.shopping_lists`)).map(
        (x) => x.id,
      ),
    ).toContain(l);
  });

  it("lista comună: toți membrii; personală: doar proprietarul (citire, scriere, ștergere); altă gospodărie: nimic", async () => {
    const common = await newList(f.A.userId, f.HA, false, "Comună");
    const personalC = await newList(f.C.userId, f.HA, true, "Doar C");
    const itemC = await newItem(f.C.userId, f.HA, personalC, "secret");
    const ids = (r: { id: string }[]) => r.map((x) => x.id);
    expect(ids(await rows(f.A.userId, f.HA, sql`select id from finet.shopping_lists`))).toContain(
      common,
    );
    expect(ids(await rows(f.C.userId, f.HA, sql`select id from finet.shopping_lists`))).toEqual(
      expect.arrayContaining([common, personalC]),
    );
    expect(
      ids(await rows(f.A.userId, f.HA, sql`select id from finet.shopping_lists`)),
    ).not.toContain(personalC);
    // Articolele moștenesc vizibilitatea listei.
    expect(
      await rows(
        f.A.userId,
        f.HA,
        sql`select id from finet.shopping_list_items where id = ${itemC}`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        f.C.userId,
        f.HA,
        sql`select id from finet.shopping_list_items where id = ${itemC}`,
      ),
    ).toHaveLength(1);
    // A nu poate scrie în lista lui C: INSERT (WITH CHECK) → 42501; UPDATE/DELETE → 0 rânduri.
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.shopping_list_items (list_id, household_id, name, normalized_name)
          values (${personalC}, ${f.HA}, 'x', 'x')`,
        ),
      ),
    ).toBe("42501");
    expect(
      await rows(
        f.A.userId,
        f.HA,
        sql`update finet.shopping_list_items set name = 'furat' where id = ${itemC} returning id`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        f.A.userId,
        f.HA,
        sql`delete from finet.shopping_lists where id = ${personalC} returning id`,
      ),
    ).toEqual([]);
    // O listă personală a altuia nu se poate crea (owner ≠ utilizator) și nici "în numele altuia".
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.shopping_lists (household_id, name, owner_user_id, created_by_user_id)
          values (${f.HA}, 'x', ${f.C.userId}, ${f.A.userId})`,
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.shopping_lists (household_id, name, created_by_user_id)
          values (${f.HA}, 'x', ${f.C.userId})`,
        ),
      ),
    ).toBe("42501");
    // Altă gospodărie (B) nu vede nimic din HA, nici cu contextul HA setat greșit.
    expect(
      await rows(
        f.B.userId,
        f.HB,
        sql`select id from finet.shopping_lists where household_id = ${f.HA}`,
      ),
    ).toEqual([]);
    expect(await rows(f.B.userId, f.HA, sql`select id from finet.shopping_lists`)).toEqual([]);
    expect(
      await sqlState(() =>
        as(
          f.B.userId,
          f.HB,
          sql`insert into finet.shopping_lists (household_id, name, created_by_user_id)
          values (${f.HA}, 'x', ${f.B.userId})`,
        ),
      ),
    ).toBe("42501");
    // Proprietarul poate trece lista la comună, dar nu alt membru să o preia / nu comună → personală.
    expect(
      await rows(
        f.C.userId,
        f.HA,
        sql`update finet.shopping_lists set owner_user_id = null where id = ${personalC} returning id`,
      ),
    ).toHaveLength(1);
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.shopping_lists set owner_user_id = ${f.A.userId} where id = ${personalC}`,
        ),
      ),
    ).toBe("23514");
  });

  it("cheia compusă: articolul nu poate indica lista altei gospodării; linia de bon trebuie să fie a gospodăriei", async () => {
    const listA = await newList(f.A.userId, f.HA, false);
    const listB = await newList(f.B.userId, f.HB, false);
    // Lista din HB cu household_id = HA: cheia compusă (list_id, household_id) refuză.
    expect(
      await sqlState(
        () =>
          f.admin`insert into finet.shopping_list_items (list_id, household_id, name, normalized_name)
          values (${listB}, ${f.HA}, 'x', 'x')`,
      ),
    ).toBe("23503");
    const savedA = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"]]);
    const savedB = await seedReceipt(f.admin, f.HB, f.B.userId, [["LAPTE"]]);
    const item = await newItem(f.A.userId, f.HA, listA);
    // Linia din HB pe un articol din HA: refuzată (cheia compusă spre receipt_lines).
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.shopping_list_items set matched_receipt_line_id = ${savedB.lineIds[0]!},
          match_status = 'suggested' where id = ${item}`,
        ),
      ),
    ).toBe("23503");
    // Bon neconfirmat: refuzat de trigger (aceeași eroare 23503).
    const draft = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"]], {
      status: "needs_review",
    });
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.shopping_list_items set matched_receipt_line_id = ${draft.lineIds[0]!},
          match_status = 'suggested' where id = ${item}`,
        ),
      ),
    ).toBe("23503");
    // Bon confirmat din HA: merge. Fără stare (`none`) cu linie → CHECK (23514).
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.shopping_list_items set matched_receipt_line_id = ${savedA.lineIds[0]!},
      match_status = 'suggested', match_score = 90, match_source = 'code' where id = ${item}`,
    );
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.shopping_list_items set match_status = 'none' where id = ${item}`,
        ),
      ),
    ).toBe("23514");
    // Ștergerea bonului: NULL DOAR pe linie; household_id și starea rămân.
    await f.admin`delete from finet.receipts where id = ${savedA.id}`;
    const [raw] = await f.admin<
      { household_id: string; matched_receipt_line_id: string | null; match_status: string }[]
    >`
      select household_id, matched_receipt_line_id, match_status from finet.shopping_list_items where id = ${item}`;
    expect(raw).toEqual({
      household_id: f.HA,
      matched_receipt_line_id: null,
      match_status: "suggested",
    });
  });

  it("o linie de bon e propusă/confirmată pentru cel mult UN articol al listei", async () => {
    const list = await newList(f.A.userId, f.HA, false);
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"], ["PAINE"]]);
    const i1 = await newItem(f.A.userId, f.HA, list, "lapte");
    const i2 = await newItem(f.A.userId, f.HA, list, "lapte 2");
    const link = (item: string, line: string, status: string) =>
      as(
        f.A.userId,
        f.HA,
        sql`update finet.shopping_list_items set matched_receipt_line_id = ${line},
        match_status = ${status} where id = ${item}`,
      );
    await link(i1, rc.lineIds[0]!, "suggested");
    expect(await sqlState(() => link(i2, rc.lineIds[0]!, "confirmed"))).toBe("23505");
    // Respins (nu ține linia în indexul unic) sau altă linie: merge.
    await link(i2, rc.lineIds[0]!, "rejected");
    await link(i1, rc.lineIds[1]!, "confirmed");
  });

  it("CHECK-uri: nume, cantitate, unitate, notă, poziție, formă bifat, scor", async () => {
    const list = await newList(f.A.userId, f.HA, false);
    const base = (over: Record<string, SQL>) => {
      const cols = { name: sql`'x'`, normalized_name: sql`'x'`, ...over };
      const names = Object.keys(cols).join(", ");
      const values = sql.join(Object.values(cols), sql`, `);
      return as(
        f.A.userId,
        f.HA,
        sql`insert into finet.shopping_list_items (list_id, household_id, ${sql.raw(names)})
        values (${list}, ${f.HA}, ${values})`,
      );
    };
    await base({});
    const bads: Record<string, SQL>[] = [
      { name: sql`''` },
      { name: sql`' x'` },
      { name: sql`repeat('a', 121)` },
      { normalized_name: sql`''` },
      { quantity: sql`0` },
      { unit: sql`''` },
      { unit: sql`repeat('a', 21)` },
      { note: sql`repeat('a', 201)` },
      { position: sql`-1` },
      { position: sql`100001` },
      { checked: sql`true` }, // bifat fără checked_at
      { checked_at: sql`now()` }, // checked_at fără bifat
      { match_score: sql`101` },
      { match_status: sql`'altceva'` },
      { match_source: sql`'altceva'` },
    ];
    for (const bad of bads) {
      expect(await sqlState(() => base(bad))).toBe("23514");
    }
    // numeric(9,3): 1.000.000 depășește precizia coloanei (22003), nu ajunge la CHECK.
    expect(await sqlState(() => base({ quantity: sql`1000000` }))).toBe("22003");
    await base({ checked: sql`true`, checked_at: sql`now()` });
    await base({ quantity: sql`999999.999`, unit: sql`'kg'`, note: sql`'bio'` });
    // Listă: nume gol/netăiat/prea lung, stare invalidă.
    for (const name of ["''", "' x '", "repeat('a', 101)"]) {
      expect(
        await sqlState(() =>
          as(
            f.A.userId,
            f.HA,
            sql`insert into finet.shopping_lists (household_id, name, created_by_user_id)
            values (${f.HA}, ${sql.raw(name)}, ${f.A.userId})`,
          ),
        ),
      ).toBe("23514");
    }
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.shopping_lists (household_id, name, status, created_by_user_id)
          values (${f.HA}, 'ok', 'altceva', ${f.A.userId})`,
        ),
      ),
    ).toBe("23514");
  });

  it("coada AI: doar pentru liste vizibile, în numele celui care cere; funcțiile întorc doar identificatori", async () => {
    const common = await newList(f.A.userId, f.HA, false);
    const personalC = await newList(f.C.userId, f.HA, true);
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"]]);
    const request = (user: string, list: string, requester = user) =>
      as(
        user,
        f.HA,
        sql`insert into finet.shopping_list_ai_requests (household_id, list_id, receipt_id, requested_by_user_id)
        values (${f.HA}, ${list}, ${rc.id}, ${requester})`,
      );
    await request(f.A.userId, common);
    // Nu în numele altcuiva; nu pe lista personală a altuia; nu pentru alt bon din altă gospodărie.
    expect(await sqlState(() => request(f.C.userId, common, f.A.userId))).toBe("42501");
    expect(await sqlState(() => request(f.A.userId, personalC))).toBe("42501");
    const foreign = await seedReceipt(f.admin, f.HB, f.B.userId, [["LAPTE"]]);
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.shopping_list_ai_requests (household_id, list_id, receipt_id, requested_by_user_id)
          values (${f.HA}, ${common}, ${foreign.id}, ${f.A.userId})`,
        ),
      ),
    ).toBe("23503");
    // Cererea e vizibilă membrilor listei comune, nu și pentru lista personală a altuia.
    await request(f.C.userId, personalC);
    expect(
      await rows(
        f.A.userId,
        f.HA,
        sql`select id from finet.shopping_list_ai_requests where list_id = ${personalC}`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        f.C.userId,
        f.HA,
        sql`select id from finet.shopping_list_ai_requests where list_id = ${personalC}`,
      ),
    ).toHaveLength(1);
    // Funcțiile cozii: doar identificatori, doar cereri `queued`/`processing` cu cel care a cerut
    // încă membru activ; finet_app nu vede tabelul fără context.
    const queued = (await f.db.execute(
      sql`select * from finet.queued_list_matches(100, 900)`,
    )) as unknown as Record<string, unknown>[];
    const mine = queued.filter((q) => q.household_id === f.HA);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(mine[0]!).sort()).toEqual(["actor_user_id", "household_id", "request_id"]);
    expect(mine.map((q) => q.actor_user_id)).toEqual(
      expect.arrayContaining([f.A.userId, f.C.userId]),
    );
    const one = (await f.db.execute(
      sql`select * from finet.queued_list_match(${mine[0]!.request_id as string}::uuid)`,
    )) as unknown as Record<string, unknown>[];
    expect(one).toHaveLength(1);
    expect(await f.db.execute(sql`select * from finet.queued_list_matches(-5, 10)`)).toHaveLength(
      0,
    );
    // O cerere terminată sau cu încercări epuizate nu mai e întoarsă.
    await f.admin`update finet.shopping_list_ai_requests set status = 'done' where list_id = ${common}`;
    await f.admin`update finet.shopping_list_ai_requests set attempts = 3 where list_id = ${personalC}`;
    const after = (await f.db.execute(
      sql`select * from finet.queued_list_matches(100, 900)`,
    )) as unknown as Record<string, unknown>[];
    expect(after.filter((q) => q.household_id === f.HA)).toEqual([]);
    // Un membru plecat nu mai are cereri în coadă (nimeni nu lucrează în numele lui).
    await f.admin`update finet.shopping_list_ai_requests set status = 'queued', attempts = 0 where list_id = ${personalC}`;
    await f.admin`delete from finet.household_members where household_id = ${f.HA} and user_id = ${f.C.userId}`;
    const gone = (await f.db.execute(
      sql`select * from finet.queued_list_matches(100, 900)`,
    )) as unknown as Record<string, unknown>[];
    expect(gone.filter((q) => q.household_id === f.HA && q.actor_user_id === f.C.userId)).toEqual(
      [],
    );
    await f.admin`insert into finet.household_members (household_id, user_id, role) values (${f.HA}, ${f.C.userId}, 'member')`;
  });

  it("coada AI: al doilea membru care reîncearcă nu primește eroare de politică (cerere activă rămâne neatinsă, terminată e preluată)", async () => {
    const list = await newList(f.A.userId, f.HA, false);
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"]]);
    const upsert = (user: string) =>
      withRlsOn(f.db, { userId: user, householdId: f.HA }, (tx) =>
        upsertAiRequest(tx, {
          householdId: f.HA,
          listId: list,
          receiptId: rc.id,
          requestedByUserId: user,
        }),
      );
    const setStatus = (status: string) =>
      f.admin`update finet.shopping_list_ai_requests set status = ${status}, attempts = 2
               where list_id = ${list} and receipt_id = ${rc.id}`;

    const first = await upsert(f.A.userId);
    expect(first.status).toBe("queued");
    expect(first.requestedByUserId).toBe(f.A.userId);

    // `queued` și `processing` ale lui A: C reîncearcă, primește rândul lui A, fără scrieri.
    for (const active of ["queued", "processing"]) {
      await setStatus(active);
      const again = await upsert(f.C.userId);
      expect(again.id).toBe(first.id);
      expect(again.status).toBe(active);
      expect(again.attempts).toBe(2);
      expect(again.requestedByUserId).toBe(f.A.userId);
    }

    // Cerere terminată: C o readuce la `queued`, devine solicitantul, încercările la 0.
    for (const terminal of ["done", "failed", "skipped"]) {
      await setStatus(terminal);
      const taken = await upsert(f.C.userId);
      expect(taken.id).toBe(first.id);
      expect(taken.status).toBe("queued");
      expect(taken.attempts).toBe(0);
      expect(taken.requestedByUserId).toBe(f.C.userId);
      // Revine la A pentru următoarea iterație.
      await f.admin`update finet.shopping_list_ai_requests set requested_by_user_id = ${f.A.userId}
                     where id = ${first.id}`;
    }
    expect(
      await f.admin`select id from finet.shopping_list_ai_requests
                     where list_id = ${list} and receipt_id = ${rc.id}`,
    ).toHaveLength(1);
  });

  it("ștergerea contului: erase_user_shopping_lists șterge listele personale din TOATE gospodăriile", async () => {
    const U = await f.newUser("Plecat");
    await f.addMember(f.A, f.HA, U);
    const personal = await newList(U.userId, f.HA, true, "Personală");
    await newItem(U.userId, f.HA, personal);
    const shared = await newList(U.userId, f.HA, false, "Comună a lui U");
    // Utilizatorul pleacă din gospodărie (nu mai poate vedea nimic), iar lista personală rămâne.
    await f.admin`delete from finet.household_members where household_id = ${f.HA} and user_id = ${U.userId}`;
    expect(await f.admin`select id from finet.shopping_lists where id = ${personal}`).toHaveLength(
      1,
    );
    const [r] = (await withRlsOn(f.db, { userId: U.userId }, (tx) =>
      tx.execute(sql`select finet.erase_user_shopping_lists() as n`),
    )) as unknown as { n: number }[];
    expect(r!.n).toBe(1);
    expect(await f.admin`select id from finet.shopping_lists where id = ${personal}`).toHaveLength(
      0,
    );
    expect(
      await f.admin`select id from finet.shopping_list_items where list_id = ${personal}`,
    ).toHaveLength(0);
    // Lista comună rămâne celorlalți (autorul devine NULL doar la ștergerea utilizatorului).
    expect(await f.admin`select id from finet.shopping_lists where id = ${shared}`).toHaveLength(1);
    // Fără utilizator în context: refuzat; funcția nu e executabilă de PUBLIC.
    expect(await sqlState(() => f.db.execute(sql`select finet.erase_user_shopping_lists()`))).toBe(
      "42501",
    );
    // Cascada: ștergerea efectivă a utilizatorului șterge listele lui personale rămase.
    const V = await f.newUser("Șters");
    await f.addMember(f.A, f.HA, V);
    const pv = await newList(V.userId, f.HA, true);
    await f.admin`delete from finet.household_members where household_id = ${f.HA} and user_id = ${V.userId}`;
    await f.admin`delete from finet.users where id = ${V.userId}`;
    expect(await f.admin`select id from finet.shopping_lists where id = ${pv}`).toHaveLength(0);
  });

  it("consimțământul AI nu apare în coadă fără rând (utilitar de test)", async () => {
    await grantExternalAi(f.admin, f.B.userId);
    const [c] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.consents where user_id = ${f.B.userId} and kind = 'external_ai'`;
    expect(c!.n).toBe(1);
  });
});
