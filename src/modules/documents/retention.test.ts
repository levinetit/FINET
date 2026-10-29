import { mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { LocalStorage } from "@/lib/storage";
import { type AuthFixture, createAuthFixture, testConfig } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { main } from "@/tools/admin/cli";

import { uploadDocuments } from "./documents.service";
import { expireDocumentFile } from "./retention";
import { multipartRequest, receiptLikeImage } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Retenția originalelor (F6-C): `admin cleanup-documents` șterge DOAR fișierele cu `expires_at`
 * trecut (ca membrul gospodăriei, sub RLS, prin `finet.expired_documents` din 0011), golește
 * `storage_key` și păstrează rândul; fișierele temporare orfane dispar; un storage nemontat nu
 * marchează nimic; ieșirea are doar contoare.
 */
describe.skipIf(!TEST_ADMIN_URL)("retenția documentelor (cleanup-documents)", () => {
  let fx: AuthFixture;
  let root: string;
  let hh: string;
  let userId: string;
  const ENV = {
    APP_MODE: "personal",
    NODE_ENV: "test",
    FINET_ROLE: "admin",
    DATABASE_URL: "postgres://finet_app:fictiv@localhost:5432/fictiv",
  };

  const cli = async (argv: string[], env: Record<string, string>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
      env,
      argv,
      readStdin: async () => "",
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      db: fx.db,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_retention");
    root = await realpath(await mkdtemp(join(tmpdir(), "finet-retention-")));
    const u = await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: "parola-retentie-12345",
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    hh = u.householdId!;
    userId = u.userId;
  });
  afterAll(async () => {
    await fx?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("șterge doar originalele expirate, păstrează rândurile; a doua rulare nu mai face nimic", async () => {
    const deps = { db: fx.db, storage: new LocalStorage(root), config: testConfig() };
    const up = async (seed: number) =>
      (
        await uploadDocuments(
          deps,
          { userId },
          hh,
          await multipartRequest([["files", await receiptLikeImage({ seed })]]),
        )
      ).documents[0]!.id;
    const old = await up(201);
    const fresh = await up(202);
    const processing = await up(203);
    await fx.scratch.admin`
      update finet.documents set expires_at = now() - interval '1 day' where id in (${old}, ${processing})`;
    await fx.scratch
      .admin`update finet.documents set status = 'processing' where id = ${processing}`;
    const dir = join(root, "households", hh, "documents");
    // Un fișier temporar orfan (scriere întreruptă), vechi.
    const tmp = join(dir, `${fresh}.tmp-7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f`);
    await writeFile(tmp, "x");
    const old2h = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(tmp, old2h, old2h);

    const r = await cli(["cleanup-documents", "--temp-hours", "1"], { ...ENV, STORAGE_DIR: root });
    expect(r, r.err).toMatchObject({ code: 0, out: "expired=1 failed=0 temp=1" });
    const files = await readdir(dir);
    expect(files.sort()).toEqual([fresh, processing].sort());
    const rows = await fx.scratch.admin<
      { id: string; storage_key: string | null; deleted: boolean }[]
    >`select id, storage_key, file_deleted_at is not null as deleted from finet.documents`;
    const byId = new Map(rows.map((x) => [x.id, x]));
    expect(byId.get(old)).toMatchObject({ storage_key: null, deleted: true });
    expect(byId.get(fresh)).toMatchObject({ deleted: false });
    expect(byId.get(processing)).toMatchObject({ deleted: false });
    const audit = await fx.scratch.admin<{ metadata: unknown }[]>`
      select metadata from finet.audit_events where action = 'documents.expired'`;
    expect(audit).toEqual([{ metadata: { files: 1 } }]);

    const again = await cli(["cleanup-documents"], { ...ENV, STORAGE_DIR: root });
    expect(again).toMatchObject({ code: 0, out: "expired=0 failed=0 temp=0" });
  });

  it("storage nemontat (fără households/) → nimic marcat; STORAGE_DIR lipsă → eroare", async () => {
    await fx.scratch
      .admin`update finet.documents set expires_at = now() - interval '1 day', status = 'needs_review'`;
    const empty = await realpath(await mkdtemp(join(tmpdir(), "finet-retention-gol-")));
    try {
      const r = await cli(["cleanup-documents"], { ...ENV, STORAGE_DIR: empty });
      expect(r).toMatchObject({ code: 0, out: "expired=0 failed=0 temp=0 storage=empty" });
      const [n] = await fx.scratch.admin<{ n: number }[]>`
        select count(*)::int as n from finet.documents where storage_key is not null`;
      expect(n!.n).toBe(2);
      const missing = await cli(["cleanup-documents"], ENV);
      expect(missing.code).toBe(1);
      expect(missing.err).toMatch(/STORAGE_DIR/);
      const bad = await cli(["cleanup-documents", "--temp-hours", "x"], {
        ...ENV,
        STORAGE_DIR: empty,
      });
      expect(bad.code).toBe(2);
      // Revizuirea F6-C: minimum 1 oră (o scriere în curs are un temporar proaspăt).
      const zero = await cli(["cleanup-documents", "--temp-hours", "0"], {
        ...ENV,
        STORAGE_DIR: empty,
      });
      expect(zero.code).toBe(2);
      expect(zero.err).toMatch(/1–9999/);
      await mkdir(join(empty, "households"));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
  it("cursa cu reprocesarea: un document expirat, dar repus în coadă, NU își pierde fișierul", async () => {
    const deps = { db: fx.db, storage: new LocalStorage(root), config: testConfig() };
    const id = (
      await uploadDocuments(
        deps,
        { userId },
        hh,
        await multipartRequest([["files", await receiptLikeImage({ seed: 204 })]]),
      )
    ).documents[0]!.id;
    // Selecția l-ar fi întors (expirat, needs_review) ...
    await fx.scratch.admin`
      update finet.documents set expires_at = now() - interval '1 day', status = 'needs_review'
       where id = ${id}`;
    // ... dar între timp reprocesarea l-a repus în coadă.
    await fx.scratch.admin`update finet.documents set status = 'queued' where id = ${id}`;
    const ref = { document_id: id, household_id: hh, actor_user_id: userId };
    expect(await expireDocumentFile(deps, ref)).toBe(false);
    await fx.scratch.admin`update finet.documents set status = 'processing' where id = ${id}`;
    expect(await expireDocumentFile(deps, ref)).toBe(false);
    expect(await readdir(join(root, "households", hh, "documents"))).toContain(id);
    const [row] = await fx.scratch.admin<{ storage_key: string | null }[]>`
      select storage_key from finet.documents where id = ${id}`;
    expect(row!.storage_key).not.toBeNull();
    // Înapoi în `needs_review`: acum se șterge.
    await fx.scratch.admin`update finet.documents set status = 'needs_review' where id = ${id}`;
    expect(await expireDocumentFile(deps, ref)).toBe(true);
    expect(await readdir(join(root, "households", hh, "documents"))).not.toContain(id);
  });
});
