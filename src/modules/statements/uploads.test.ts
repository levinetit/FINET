import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildStatementFixtures } from "../../../scripts/make-statement-fixtures.mjs";

import { TEST_ADMIN_URL } from "@/db/testing";
import { LocalStorage, isStorageKey } from "@/lib/storage";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import {
  handleStatementParse,
  handleStatementSweep,
  listQueuedUploads,
  processStatementUpload,
} from "@/worker/statements/statement-jobs";

import { cleanupStatementFiles } from "./cleanup";
import {
  confirmStatementImport,
  discardStatementPreview,
  getStatementImport,
} from "./statements.service";
import { buildZip, itemsToPdf } from "./testing";
import {
  cancelStatementUpload,
  getStatementUpload,
  importStatementUpload,
  releaseUploadFiles,
  uploadFilesOfImport,
} from "./uploads.service";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const fixtures = buildStatementFixtures();
const one = <T>(a: readonly T[]): T => {
  if (!a[0]) throw new Error("niciun rezultat");
  return a[0];
};
const CSV = Buffer.from(
  [
    "Data;Descriere;Suma;Referinta",
    "03.11.2026;Cafenea Exemplu;-15,00;R1",
    "04.11.2026;Salariu;4500,00;R2",
    "05.11.2026;=HYPERLINK(1);-1,00;R3",
  ].join("\r\n"),
  "utf8",
);
const MAPPING = {
  headerRow: 0,
  date: 0,
  dateFormat: "dmy_dot",
  amount: 2,
  decimal: ",",
  thousands: "",
  description: [1],
  reference: 3,
};

/**
 * Calea completă a unui extras încărcat (F7-B; ADR 0018 §11) pe PostgreSQL real, ca `finet_app`:
 * CSV cu mapare (fără stocare), PDF păstrat temporar → workerul (procesul copil real, PDF sintetic)
 * → previzualizare → confirmare → fișierul șters; cota consumată înainte de citire; cont personal
 * invizibil; ZIP cu părți bune și rele; curățarea fișierelor expirate.
 */
describe.skipIf(!TEST_ADMIN_URL)("încărcarea extraselor (Postgres real, finet_app)", () => {
  let f: FamilyFixture;
  let dir: string;
  let storage: LocalStorage;
  let ron: string;
  let personalC: string;
  let now = new Date("2026-11-20T10:00:00Z");
  const deps = (over: Record<string, unknown> = {}) => ({
    db: f.db,
    storage,
    now: () => now,
    ...over,
  });
  const usage = async () => {
    const [r] = await f.admin<{ n: number }[]>`
      select coalesce(sum(count), 0)::int as n from finet.statement_usage_daily
       where household_id = ${f.HA}`;
    return r!.n;
  };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_stmtupl");
    dir = await mkdtemp(join(tmpdir(), "finet-stmt-up-"));
    storage = new LocalStorage(dir);
    ron = (
      await createAccount({ db: f.db }, f.A, f.HA, { name: "BT", type: "bank", currency: "RON" })
    ).id;
    personalC = (
      await createAccount({ db: f.db }, f.C, f.HA, {
        name: "Personal C",
        type: "bank",
        currency: "RON",
        ownerUserId: f.C.userId,
      })
    ).id;
  });
  afterAll(async () => {
    await f?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("CSV fără mapare: cere maparea (sugestie + probă), nimic stocat; cu mapare: previzualizare", async () => {
    const before = await usage();
    const first = one(
      await importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: CSV }),
    );
    expect(first).toMatchObject({ kind: "mapping_required", format: "csv", rowCount: 4 });
    if (first.kind !== "mapping_required") throw new Error("x");
    expect(first.sample[0]).toEqual(["Data", "Descriere", "Suma", "Referinta"]);
    expect(first.suggestion.mapping).toMatchObject({ date: 0, description: [1] });
    expect(await usage()).toBe(before + 1);
    const second = one(
      await importStatementUpload(deps(), f.A, f.HA, {
        accountId: ron,
        bytes: CSV,
        mapping: MAPPING,
      }),
    );
    expect(second.kind).toBe("preview");
    if (second.kind !== "preview") throw new Error("x");
    expect(second.preview.import).toMatchObject({
      status: "previewed",
      format: "csv",
      lineCount: 3,
    });
    // Textul periculos rămâne text (neutralizat doar la export CSV).
    expect(second.preview.import.lines!.some((l) => l.description.startsWith("=HYPERLINK"))).toBe(
      true,
    );
    expect(await usage()).toBe(before + 2);
    await discardStatementPreview(deps(), f.A, f.HA, second.preview.import.id);
  });

  it("cota se consumă ÎNAINTE de citire: un fișier invalid consumă și el; peste limită → 409", async () => {
    const before = await usage();
    await expect(
      importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: Buffer.from([0, 1, 2]) }),
    ).rejects.toMatchObject({ code: "csv_invalid" });
    expect(await usage()).toBe(before + 1);
    await expect(
      importStatementUpload(deps({ dailyLimit: before + 1 }), f.A, f.HA, {
        accountId: ron,
        bytes: CSV,
      }),
    ).rejects.toMatchObject({ reason: "statement_daily_limit" });
  });

  it("contul PERSONAL al altui membru și contul altei gospodării: 404, nimic consumat sau stocat", async () => {
    const before = await usage();
    await expect(
      importStatementUpload(deps(), f.A, f.HA, {
        accountId: personalC,
        bytes: itemsToPdf(fixtures.bt.items),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      importStatementUpload(deps(), f.B, f.HB, { accountId: ron, bytes: CSV }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await usage()).toBe(before);
  });

  it("PDF: păstrat temporar → workerul (copil real) → previzualizare → confirmare → fișierul șters", async () => {
    const pdf = itemsToPdf(fixtures.bt.items);
    const q = one(await importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: pdf }));
    expect(q).toMatchObject({ kind: "queued", duplicate: false });
    if (q.kind !== "queued") throw new Error("x");
    expect(q.upload).toMatchObject({ status: "queued", fileDeleted: false, importId: null });
    // Același fișier încă în lucru: aceeași încărcare (nimic nou păstrat).
    const again = one(
      await importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: pdf }),
    );
    expect(again).toMatchObject({ kind: "queued", duplicate: true });
    // Membrul C nu vede încărcarea? O vede: contul e comun. B (altă gospodărie): 404.
    await expect(getStatementUpload(deps(), f.B, f.HB, q.upload.id)).rejects.toMatchObject({
      status: 404,
    });
    // Coada: doar identificatori; jobul cu gospodăria greșită nu face nimic.
    const sent: string[] = [];
    expect(await handleStatementSweep({ db: f.db }, async (id) => sent.push(id))).toBe(1);
    expect(sent).toEqual([q.upload.id]);
    expect(
      await handleStatementParse(
        { db: f.db, storage },
        { uploadId: q.upload.id, householdId: f.HB },
      ),
    ).toEqual({ rejected: "not_found" });
    expect(
      await handleStatementParse({ db: f.db, storage }, { uploadId: "x", householdId: f.HA }),
    ).toEqual({ rejected: "invalid_data" });
    const r = await handleStatementParse(
      { db: f.db, storage },
      { uploadId: q.upload.id, householdId: f.HA },
    );
    expect(r).toEqual({ outcome: "parsed" });
    const up = await getStatementUpload(deps(), f.A, f.HA, q.upload.id);
    expect(up.status).toBe("parsed");
    const imp = await getStatementImport(deps(), f.A, f.HA, up.importId!);
    expect(imp).toMatchObject({
      bank: "bt",
      format: "pdf",
      status: "previewed",
      balanceStatus: "ok",
    });
    // Confirmare, apoi fișierul sursă se șterge.
    const files = await uploadFilesOfImport(deps(), f.A, f.HA, imp.id);
    expect(files).toHaveLength(1);
    await confirmStatementImport(deps(), f.A, f.HA, imp.id);
    expect(await releaseUploadFiles(deps(), f.A, f.HA, files)).toBe(1);
    const after = await getStatementUpload(deps(), f.A, f.HA, q.upload.id);
    expect(after.fileDeleted).toBe(true);
    expect(await storage.exists(files[0]!.storageKey as never)).toBe(false);
    // Reîncărcarea aceluiași PDF: „deja importat”, fără job nou.
    const re = one(await importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: pdf }));
    expect(re).toMatchObject({ kind: "preview", preview: { alreadyImported: true } });
    expect(await listQueuedUploads(f.db)).toHaveLength(0);
  });

  it("PDF invalid / altă monedă: încărcarea devine `failed` cu cod fix, fără reîncercare infinită", async () => {
    const eur = (
      await createAccount({ db: f.db }, f.A, f.HA, { name: "EUR", type: "bank", currency: "EUR" })
    ).id;
    const q = one(
      await importStatementUpload(deps(), f.A, f.HA, {
        accountId: eur,
        bytes: itemsToPdf(fixtures.revolut.items),
      }),
    );
    if (q.kind !== "queued") throw new Error("x");
    const [ref] = await listQueuedUploads(f.db);
    expect(await processStatementUpload({ db: f.db, storage }, ref!)).toEqual({
      outcome: "failed",
      code: "statement_currency_mismatch",
    });
    const junk = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x41)]);
    const j = one(await importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: junk }));
    if (j.kind !== "queued") throw new Error("x");
    const [ref2] = await listQueuedUploads(f.db);
    const out = await processStatementUpload({ db: f.db, storage }, ref2!);
    expect(out.outcome).toBe("failed");
    expect(await listQueuedUploads(f.db)).toHaveLength(0);
    // Renunțarea la o încărcare eșuată: fișierul se șterge.
    const v = await cancelStatementUpload(deps(), f.A, f.HA, j.upload.id);
    expect(v).toMatchObject({ status: "failed", fileDeleted: true });
  });

  it("ZIP: fiecare fișier separat; unul corupt e refuzat cu cod, celelalte trec; cota = numărul fișierelor", async () => {
    const before = await usage();
    const zip = buildZip([
      { name: "a.csv", data: CSV },
      { name: "b.csv", data: Buffer.from([0, 0, 0]) },
    ]);
    const out = await importStatementUpload(deps(), f.A, f.HA, {
      accountId: ron,
      bytes: zip,
      mapping: MAPPING,
    });
    expect(out.map((o) => o.kind)).toEqual(["preview", "rejected"]);
    expect(out[1]).toMatchObject({ code: "csv_invalid" });
    expect(await usage()).toBe(before + 2);
  });

  it("curățarea: fișierele expirate se șterg (și ale unui autor plecat), previzualizările vechi dispar", async () => {
    const pdf = itemsToPdf(fixtures.brd.items);
    const q = one(await importStatementUpload(deps(), f.A, f.HA, { accountId: ron, bytes: pdf }));
    if (q.kind !== "queued") throw new Error("x");
    const [row] = await f.admin<{ key: string }[]>`
      select storage_key as key from finet.statement_uploads where id = ${q.upload.id}`;
    expect(isStorageKey(row!.key)).toBe(true);
    expect(await storage.exists(row!.key as never)).toBe(true);
    await f.admin`update finet.statement_uploads set created_at = now() - interval '3 days',
                    expires_at = now() - interval '2 days' where id = ${q.upload.id}`;
    // O previzualizare veche de 8 zile.
    const p = one(
      await importStatementUpload(deps(), f.A, f.HA, {
        accountId: ron,
        bytes: Buffer.concat([CSV, Buffer.from("\r\n06.11.2026;X;-2,00;R4")]),
        mapping: MAPPING,
      }),
    );
    if (p.kind !== "preview") throw new Error("x");
    await f.admin`update finet.statement_imports set created_at = now() - interval '8 days'
                   where id = ${p.preview.import.id}`;
    const r = await cleanupStatementFiles({ db: f.db, storage });
    // Fișierul expirat + PDF-ul eșuat (altă monedă) din testul anterior.
    expect(r).toMatchObject({ files: 2, failed: 0 });
    expect(r.previews).toBeGreaterThanOrEqual(1);
    expect(await storage.exists(row!.key as never)).toBe(false);
    const after = await getStatementUpload(deps(), f.A, f.HA, q.upload.id);
    expect(after).toMatchObject({
      status: "failed",
      errorCode: "upload_expired",
      fileDeleted: true,
    });
    await expect(getStatementImport(deps(), f.A, f.HA, p.preview.import.id)).rejects.toMatchObject({
      status: 404,
    });
    // A doua rulare: nimic.
    expect(await cleanupStatementFiles({ db: f.db, storage })).toEqual({
      files: 0,
      failed: 0,
      previews: 0,
    });
    now = new Date("2026-11-20T10:00:00Z");
  });
});
