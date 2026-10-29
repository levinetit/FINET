import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildStatementFixtures } from "../../../scripts/make-statement-fixtures.mjs";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount, getAccount } from "@/modules/accounts/accounts.service";
import { collectCsv, exportTransactionsCsv } from "@/modules/exports/exports.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { updateTransaction } from "@/modules/transactions/transactions.service";

import { parseCsv } from "./csv";
import { parsePdfItems } from "./detect";
import { mapTable } from "./mapping";
import {
  cancelStatementImport,
  confirmStatementImport,
  createStatementPreview,
  discardStatementPreview,
  getStatementCoverage,
  getStatementImport,
  listStatementImports,
} from "./statements.service";
import type { ParsedStatement } from "./types";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fixtures = buildStatementFixtures();
const bt = () => parsePdfItems(fixtures.bt.items);
const revolut = () => parsePdfItems(fixtures.revolut.items);

/**
 * Serviciile importului de extrase pe PostgreSQL real, ca `finet_app` (ADR 0018): previzualizare
 * fără scriere în registru, confirmare idempotentă, import dublu, importuri suprapuse, anulare
 * (cu tranzacții editate), transfer valutar cu două monede, acoperire pe luni, cota zilnică și
 * izolarea între gospodării și între membri (cont personal).
 */
describe.skipIf(!TEST_ADMIN_URL)("importul extraselor (Postgres real, finet_app)", () => {
  let f: FamilyFixture;
  let ron: string;
  let eur: string;
  let personalC: string;
  const now = () => new Date("2026-11-20T10:00:00Z");
  const deps = (over: Record<string, unknown> = {}) => ({ db: f.db, now, ...over });
  const count = async (accountId: string) => {
    const [r] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id = ${accountId}`;
    return r!.n;
  };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_stmt");
    const mk = async (actor: typeof f.A, name: string, currency: "RON" | "EUR", owner?: string) =>
      (
        await createAccount({ db: f.db }, actor, f.HA, {
          name,
          type: "bank",
          currency,
          ...(owner ? { ownerUserId: owner } : {}),
        })
      ).id;
    ron = await mk(f.A, "Banca RON", "RON");
    eur = await mk(f.A, "Banca EUR", "EUR");
    personalC = await mk(f.C, "Revolut C", "RON", f.C.userId);
  });
  afterAll(async () => {
    await f?.close();
  });

  it("previzualizare: fără scriere în registru; aceeași cerere = aceeași previzualizare", async () => {
    const before = await count(ron);
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: ron,
      sourceSha256: sha("bt-1"),
      parsed: bt(),
    });
    expect(p.alreadyImported).toBe(false);
    expect(p.import).toMatchObject({ status: "previewed", balanceStatus: "ok", pendingCount: 3 });
    expect(p.import.lines!.every((l) => l.state === "new")).toBe(true);
    expect(p.import.warnings).toContain("pending_skipped");
    expect(await count(ron)).toBe(before);
    const again = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: ron,
      sourceSha256: sha("bt-1"),
      parsed: bt(),
    });
    expect(again.import.id).toBe(p.import.id);
    // Moneda contului trebuie să fie a extrasului.
    await expect(
      createStatementPreview(deps(), f.A, f.HA, {
        accountId: eur,
        sourceSha256: sha("x"),
        parsed: bt(),
      }),
    ).rejects.toMatchObject({ reason: "statement_currency_mismatch" });
  });

  it("confirmare: tranzacții `statement`, idempotentă; reimport = 0 tranzacții noi", async () => {
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: ron,
      sourceSha256: sha("bt-1"),
      parsed: bt(),
    });
    const before = await count(ron);
    const done = await confirmStatementImport(deps(), f.A, f.HA, p.import.id);
    expect(done).toMatchObject({ status: "imported", importedCount: 9 });
    expect(await count(ron)).toBe(before + 9);
    const rows = await f.admin<{ source: string; ref: string; type: string }[]>`
      select source, external_ref as ref, type from finet.transactions where account_id = ${ron}`;
    expect(rows.every((r) => r.source === "statement" && r.ref.startsWith("stmt:"))).toBe(true);
    // Cele două cafele identice din aceeași zi sunt două tranzacții.
    const [cafe] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id = ${ron} and amount_minor = 1500`;
    expect(cafe!.n).toBe(2);
    // Soldul: venituri − cheltuieli ale extrasului.
    const expected = bt().lines.reduce(
      (s, l) => s + (l.direction === "credit" ? l.amountMinor : -l.amountMinor),
      0n,
    );
    expect((await getAccount({ db: f.db }, f.A, f.HA, ron)).balanceMinor).toBe(expected);
    // A doua confirmare: același rezultat, nimic nou.
    await confirmStatementImport(deps(), f.A, f.HA, p.import.id);
    expect(await count(ron)).toBe(before + 9);
    // Același fișier: „deja importat”.
    const same = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: ron,
      sourceSha256: sha("bt-1"),
      parsed: bt(),
    });
    expect(same).toMatchObject({ alreadyImported: true, import: { id: p.import.id } });
    // Același conținut, alt fișier (alt sha): toate rândurile sunt duplicate.
    const dup = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: ron,
      sourceSha256: sha("bt-1-copie"),
      parsed: bt(),
    });
    expect(dup.import.lines!.every((l) => l.state === "duplicate")).toBe(true);
    expect(dup.import.warnings).toEqual(
      expect.arrayContaining(["duplicates_found", "overlapping_import"]),
    );
    const d2 = await confirmStatementImport(deps(), f.A, f.HA, dup.import.id);
    expect(d2.importedCount).toBe(0);
    expect(await count(ron)).toBe(before + 9);
  });

  it("import suprapus parțial: doar rândurile noi intră", async () => {
    const base = bt();
    const extra = {
      ...base.lines[0]!,
      rowNo: base.lines.length + 1,
      occurredOn: "2026-11-06",
      amountMinor: 3333n,
      direction: "debit" as const,
      description: "Plata noua",
    };
    const parsed: ParsedStatement = {
      ...base,
      lines: [...base.lines.slice(5), extra],
      openingBalanceMinor: null,
      closingBalanceMinor: null,
      dayBalances: [],
    };
    const before = await count(ron);
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: ron,
      sourceSha256: sha("bt-partial"),
      parsed,
    });
    expect(p.import.lines!.map((l) => l.state)).toEqual([
      ...base.lines.slice(5).map(() => "duplicate"),
      "new",
    ]);
    expect(p.import.balanceStatus).toBe("unknown");
    await confirmStatementImport(deps(), f.A, f.HA, p.import.id);
    expect(await count(ron)).toBe(before + 1);
  });

  it("sold nepotrivit: confirmarea cere recunoașterea explicită", async () => {
    const base = bt();
    const parsed = { ...base, closingBalanceMinor: base.closingBalanceMinor! + 100n };
    const acc = (
      await createAccount({ db: f.db }, f.A, f.HA, { name: "Sold", type: "bank", currency: "RON" })
    ).id;
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: acc,
      sourceSha256: sha("mismatch"),
      parsed,
    });
    expect(p.import.balanceStatus).toBe("mismatch");
    expect(p.balanceReasons).toContain("closing_balance");
    await expect(confirmStatementImport(deps(), f.A, f.HA, p.import.id)).rejects.toMatchObject({
      reason: "statement_balance_mismatch",
    });
    const done = await confirmStatementImport(deps(), f.A, f.HA, p.import.id, {
      acknowledgeBalanceMismatch: true,
      skipRows: [1],
    });
    expect(done.importedCount).toBe(8);
    expect(done.lines![0]!.state).toBe("skipped");
  });

  it("anulare: șterge doar ce a creat; tranzacțiile editate cer decizie; reimportul e posibil", async () => {
    const acc = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "Anulare",
        type: "bank",
        currency: "RON",
      })
    ).id;
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: acc,
      sourceSha256: sha("cancel"),
      parsed: bt(),
    });
    const done = await confirmStatementImport(deps(), f.A, f.HA, p.import.id);
    const edited = done.lines!.find((l) => l.state === "imported")!.transactionId!;
    await updateTransaction({ db: f.db }, f.A, f.HA, edited, { notes: "verificat" });
    await expect(cancelStatementImport(deps(), f.A, f.HA, p.import.id)).rejects.toMatchObject({
      reason: "statement_import_has_edited",
    });
    const c = await cancelStatementImport(deps(), f.A, f.HA, p.import.id, { editedPolicy: "keep" });
    expect(c).toMatchObject({ status: "cancelled", keptEdited: 1 });
    expect(c.lines!.every((l) => l.state === "cancelled")).toBe(true);
    expect(await count(acc)).toBe(1);
    // Anularea e idempotentă; un import anulat nu se mai confirmă.
    await cancelStatementImport(deps(), f.A, f.HA, p.import.id);
    await expect(confirmStatementImport(deps(), f.A, f.HA, p.import.id)).rejects.toMatchObject({
      reason: "statement_import_not_previewed",
    });
    // Reimportul: același fișier e din nou previzualizabil; tranzacția păstrată e duplicat.
    const again = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: acc,
      sourceSha256: sha("cancel"),
      parsed: bt(),
    });
    expect(again.alreadyImported).toBe(false);
    expect(again.import.lines!.filter((l) => l.state === "duplicate")).toHaveLength(1);
    await confirmStatementImport(deps(), f.A, f.HA, again.import.id);
    expect(await count(acc)).toBe(9);
    // `delete`: șterge și tranzacțiile editate.
    const imp = await listStatementImports(deps(), f.A, f.HA, { accountId: acc });
    const last = imp.find((i) => i.status === "imported")!;
    await updateTransaction(
      { db: f.db },
      f.A,
      f.HA,
      (await getStatementImport(deps(), f.A, f.HA, last.id)).lines!.find(
        (l) => l.state === "imported",
      )!.transactionId!,
      { notes: "x" },
    );
    await cancelStatementImport(deps(), f.A, f.HA, last.id, { editedPolicy: "delete" });
    expect(await count(acc)).toBe(1);
  });

  it("schimb valutar Revolut: transfer cu ambele sume; extrasul contului EUR îl vede ca duplicat", async () => {
    const revRon = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "Revolut RON",
        type: "bank",
        currency: "RON",
      })
    ).id;
    const revEur = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "Revolut EUR",
        type: "bank",
        currency: "EUR",
      })
    ).id;
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: revRon,
      sourceSha256: sha("rev"),
      parsed: revolut(),
    });
    const fxRow = p.import.lines!.find((l) => l.kind === "fx")!;
    await expect(confirmStatementImport(deps(), f.A, f.HA, p.import.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      confirmStatementImport(deps(), f.A, f.HA, p.import.id, {
        fx: [{ rowNo: fxRow.rowNo, mode: "transfer", counterpartAccountId: ron }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await confirmStatementImport(deps(), f.A, f.HA, p.import.id, {
      fx: [{ rowNo: fxRow.rowNo, mode: "transfer", counterpartAccountId: revEur }],
    });
    const legs = await f.admin<
      { account_id: string; amount_minor: string; currency: string; dir: string }[]
    >`
      select account_id, amount_minor::text, currency, transfer_direction as dir
        from finet.transactions where type = 'transfer' and account_id in (${revRon}, ${revEur})
       order by dir`;
    expect(legs).toEqual([
      { account_id: revEur, amount_minor: "1000", currency: "EUR", dir: "in" },
      { account_id: revRon, amount_minor: "4975", currency: "RON", dir: "out" },
    ]);
    // Extrasul EUR (sintetic, aceeași zi): rândul „Schimbat din RON” e deja în registru.
    const eurParsed: ParsedStatement = {
      ...revolut(),
      currency: "EUR",
      openingBalanceMinor: null,
      closingBalanceMinor: null,
      lines: [
        {
          rowNo: 1,
          occurredOn: fxRow.occurredOn,
          direction: "credit",
          amountMinor: 1000n,
          description: "Schimbat din RON",
          bankReference: "eur-side",
          kind: "fx",
          fxAmountMinor: 4975n,
          fxCurrency: "RON",
          balanceAfterMinor: null,
        },
      ],
    };
    const e = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: revEur,
      sourceSha256: sha("rev-eur"),
      parsed: eurParsed,
    });
    expect(e.import.lines![0]!.state).toBe("duplicate");
  });

  it("două schimburi identice în aceeași zi: două transferuri, ambele văzute ca duplicate din extrasul EUR; piciorul deja importat → conflict clar", async () => {
    const r = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "FX RON",
        type: "bank",
        currency: "RON",
      })
    ).id;
    const e = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "FX EUR",
        type: "bank",
        currency: "EUR",
      })
    ).id;
    const fxLine = (
      rowNo: number,
      direction: "debit" | "credit",
      amountMinor: bigint,
      fxAmountMinor: bigint,
      fxCurrency: "EUR" | "RON",
    ) => ({
      rowNo,
      occurredOn: "2026-11-10",
      direction,
      amountMinor,
      description: "Schimbat",
      bankReference: `fx-${rowNo}-${direction}`,
      kind: "fx" as const,
      fxAmountMinor,
      fxCurrency,
      balanceAfterMinor: null,
    });
    const base = { ...revolut(), openingBalanceMinor: null, closingBalanceMinor: null };
    const ronSide: ParsedStatement = {
      ...base,
      lines: [fxLine(1, "debit", 500n, 100n, "EUR"), fxLine(2, "debit", 500n, 100n, "EUR")],
    };
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: r,
      sourceSha256: sha("fx2"),
      parsed: ronSide,
    });
    await confirmStatementImport(deps(), f.A, f.HA, p.import.id, {
      fx: [1, 2].map((rowNo) => ({ rowNo, mode: "transfer" as const, counterpartAccountId: e })),
    });
    expect(await count(e)).toBe(2);
    const eurSide: ParsedStatement = {
      ...base,
      currency: "EUR",
      lines: [fxLine(1, "credit", 100n, 500n, "RON"), fxLine(2, "credit", 100n, 500n, "RON")],
    };
    const q = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: e,
      sourceSha256: sha("fx2-eur"),
      parsed: eurSide,
    });
    expect(q.import.lines!.map((l) => l.state)).toEqual(["duplicate", "duplicate"]);
    // Ordinea inversă: extrasul EUR importat întâi ca venit (`plain`), apoi cel RON ca transfer.
    const r2 = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "FX RON 2",
        type: "bank",
        currency: "RON",
      })
    ).id;
    const e2 = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "FX EUR 2",
        type: "bank",
        currency: "EUR",
      })
    ).id;
    const pe = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: e2,
      sourceSha256: sha("fx3-eur"),
      parsed: { ...eurSide, lines: [eurSide.lines[0]!] },
    });
    await confirmStatementImport(deps(), f.A, f.HA, pe.import.id, {
      fx: [{ rowNo: 1, mode: "plain" }],
    });
    const pr = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: r2,
      sourceSha256: sha("fx3-ron"),
      parsed: { ...ronSide, lines: [ronSide.lines[0]!] },
    });
    await expect(
      confirmStatementImport(deps(), f.A, f.HA, pr.import.id, {
        fx: [{ rowNo: 1, mode: "transfer", counterpartAccountId: e2 }],
      }),
    ).rejects.toMatchObject({ reason: "statement_fx_counterpart_exists" });
    const ok = await confirmStatementImport(deps(), f.A, f.HA, pr.import.id, {
      fx: [{ rowNo: 1, mode: "plain" }],
    });
    expect(ok.importedCount).toBe(1);
  });

  it("izolare: altă gospodărie și contul PERSONAL al altui membru sunt invizibile (404)", async () => {
    const p = await createStatementPreview(deps(), f.C, f.HA, {
      accountId: personalC,
      sourceSha256: sha("perso"),
      parsed: revolut(),
    });
    await expect(getStatementImport(deps(), f.A, f.HA, p.import.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(confirmStatementImport(deps(), f.A, f.HA, p.import.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getStatementImport(deps(), f.B, f.HB, p.import.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      createStatementPreview(deps(), f.A, f.HA, {
        accountId: personalC,
        sourceSha256: sha("x2"),
        parsed: revolut(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createStatementPreview(deps(), f.B, f.HB, {
        accountId: ron,
        sourceSha256: sha("x3"),
        parsed: bt(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await listStatementImports(deps(), f.A, f.HA)).some((i) => i.id === p.import.id)).toBe(
      false,
    );
    expect((await listStatementImports(deps(), f.C, f.HA)).some((i) => i.id === p.import.id)).toBe(
      true,
    );
    const covA = await getStatementCoverage(deps(), f.A, f.HA, { from: "2026-11", to: "2026-11" });
    expect(covA.some((r) => r.accountId === personalC)).toBe(false);
    await discardStatementPreview(deps(), f.C, f.HA, p.import.id);
    await expect(getStatementImport(deps(), f.C, f.HA, p.import.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("acoperire pe luni: parțial până la ultima zi acoperită, lipsă, avertizare luni lipsă", async () => {
    const cov = await getStatementCoverage(deps(), f.A, f.HA, { from: "2026-10", to: "2026-12" });
    const row = cov.find((r) => r.accountId === ron)!;
    expect(row.months.map((m) => [m.month, m.status])).toEqual([
      ["2026-10", "missing"],
      ["2026-11", "partial"],
      ["2026-12", "missing"],
    ]);
    expect(row.months[1]!.coveredUntil).toBe("2026-11-05");
    expect(row.missingMonths).toEqual([]);
    await expect(
      getStatementCoverage(deps(), f.A, f.HA, { from: "2026-12", to: "2026-10" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("cota zilnică: doar crescătoare (renunțarea nu o eliberează)", async () => {
    const acc = (
      await createAccount({ db: f.db }, f.B, f.HB, { name: "B", type: "bank", currency: "RON" })
    ).id;
    const d = deps({ dailyLimit: 1 });
    const p = await createStatementPreview(d, f.B, f.HB, {
      accountId: acc,
      sourceSha256: sha("q1"),
      parsed: bt(),
    });
    await discardStatementPreview(d, f.B, f.HB, p.import.id);
    await expect(
      createStatementPreview(d, f.B, f.HB, {
        accountId: acc,
        sourceSha256: sha("q2"),
        parsed: bt(),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("CSV cu prefixe periculoase: textul se importă ca text, exportul îl neutralizează", async () => {
    const acc = (
      await createAccount({ db: f.db }, f.A, f.HA, { name: "CSV", type: "bank", currency: "RON" })
    ).id;
    const table = parseCsv(
      Buffer.from(
        'Data;Descriere;Suma\n03.11.2026;=HYPERLINK("http://exemplu.invalid");-5,00\n04.11.2026;@SUM(A1);-6,00\n',
      ),
    );
    const parsed = mapTable(
      table,
      {
        headerRow: 0,
        date: 0,
        dateFormat: "dmy_dot",
        amount: 2,
        decimal: ",",
        thousands: "",
        description: [1],
      },
      { currency: "RON", format: "csv" },
    );
    const p = await createStatementPreview(deps(), f.A, f.HA, {
      accountId: acc,
      sourceSha256: sha("csv"),
      parsed,
    });
    await confirmStatementImport(deps(), f.A, f.HA, p.import.id);
    const csv = await collectCsv(
      exportTransactionsCsv({ db: f.db, now }, f.A, f.HA, { accountId: acc }),
    );
    expect(csv).not.toMatch(/(^|,)"?[=@]/m);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'@SUM");
  });
});
