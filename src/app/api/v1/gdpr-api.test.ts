import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { createHousehold } from "@/db/households";
import { TEST_ADMIN_URL } from "@/db/testing";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { MemoryStorage } from "@/modules/gdpr/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";

import * as G from "./_lib/gdpr-handlers";
import { type Sessions, apiRequest, assertContract, readJson, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Lista intrărilor arhivei (Python `zipfile`, verificare independentă) sau `null` fără Python. */
function zipListing(zip: Buffer): Record<string, string> | null {
  if (!hasPython()) return null;
  const dir = mkdtempSync(join(tmpdir(), "finet-gdpr-zip-"));
  try {
    const file = join(dir, "e.zip");
    writeFileSync(file, zip);
    const script = [
      "import sys, zipfile, json",
      "z = zipfile.ZipFile(sys.argv[1])",
      "assert z.testzip() is None",
      "print(json.dumps({i.filename: z.read(i).decode('utf-8', 'replace') for i in z.infolist()}))",
    ].join("\n");
    return JSON.parse(execFileSync("python3", ["-I", "-c", script, file]).toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!TEST_ADMIN_URL)("API GDPR și statistici (PostgreSQL real)", () => {
  let fx: AuthFixture;
  let env: AuthEnv & G.GdprApiDeps;
  const storage = new MemoryStorage();
  let ana: { id: string; hh: string; S: Sessions };
  let bogdan: { id: string; hh: string; S: Sessions };
  const PASS_A = "parola-ana-gdpr-123";
  const PASS_B = "parola-bogdan-gdpr-123";

  async function makeUser(email: string, name: string, password: string, admin: boolean) {
    const r = await createUserWithHousehold(fx.db, {
      email,
      name,
      password,
      firstUserBecomesAdmin: admin,
      emailVerified: true,
    });
    return { id: r.userId, hh: r.householdId!, S: await sessionsFor(env, email, password) };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_gdpr_api");
    env = { ...authEnv(fx.db), storage };
    ana = await makeUser("ana@exemplu.ro", "Ana", PASS_A, true);
    bogdan = await makeUser("bogdan@exemplu.ro", "Bogdan", PASS_B, false);
  });

  afterAll(async () => {
    await fx?.close();
  });

  const call = async (
    handler: (r: Request, d: G.GdprApiDeps) => Promise<Response>,
    path: string,
    init: Parameters<typeof apiRequest>[1] = {},
  ) => {
    const r = await handler(apiRequest(path, init), env);
    await assertContract(handler, r);
    return r;
  };

  it("fără sesiune → 401 pe toate", async () => {
    expect((await call(G.dataExportHandler, "/api/v1/me/export")).status).toBe(401);
    expect((await call(G.deletionPreviewHandler, "/api/v1/me/deletion")).status).toBe(401);
    expect(
      (await call(G.deleteAccountHandler, "/api/v1/me/delete", { body: { confirm: "ȘTERGE" } }))
        .status,
    ).toBe(401);
    expect((await call(G.usageStatsHandler, "/api/v1/admin/stats")).status).toBe(401);
  });

  it("statisticile: administratorul → 200 fără date financiare; un membru obișnuit → 403", async () => {
    const ok = await call(G.usageStatsHandler, "/api/v1/admin/stats", { bearer: ana.S.bearer });
    expect(ok.status).toBe(200);
    const body = await readJson(ok);
    expect((body.data as { members: unknown[] }).members.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(body)).not.toMatch(/exemplu\.ro|amountMinor|description/);
    const no = await call(G.usageStatsHandler, "/api/v1/admin/stats", { bearer: bogdan.S.bearer });
    expect(no.status).toBe(403);
  });

  it("exportul: cu cookie cere Sec-Fetch-Site same-origin; arhiva conține doar datele vizibile utilizatorului, fără parole sau tokenuri", async () => {
    // Bogdan intră în gospodăria Anei; Ana are un cont personal acolo, Bogdan unul comun.
    await fx.scratch.admin`insert into finet.household_members (household_id, user_id, role)
      values (${ana.hh}, ${bogdan.id}, 'member')`;
    const deps = { db: fx.db };
    const anaPersonal = await createAccount(deps, { userId: ana.id }, ana.hh, {
      name: "Personal Ana",
      type: "cash",
      currency: "RON",
      ownerUserId: ana.id,
    });
    await createTransaction(deps, { userId: ana.id }, ana.hh, {
      accountId: anaPersonal.id,
      type: "expense",
      amountMinor: 424242,
      occurredOn: "2026-10-10",
      description: "Secretul Anei",
    });
    const common = await createAccount(deps, { userId: bogdan.id }, ana.hh, {
      name: "Comun",
      type: "cash",
      currency: "RON",
    });
    await createTransaction(deps, { userId: bogdan.id }, ana.hh, {
      accountId: common.id,
      type: "expense",
      amountMinor: 1500,
      occurredOn: "2026-10-11",
      description: "Pâine comună",
    });
    // Un bon al lui Bogdan (cu fișier) în gospodăria lui.
    const docId = randomUUID();
    const key = `households/${bogdan.hh}/documents/${docId}`;
    await fx.scratch
      .admin`insert into finet.documents (id, household_id, uploaded_by_user_id, status,
        storage_key, detected_mime, size_bytes, sha256)
      values (${docId}, ${bogdan.hh}, ${bogdan.id}, 'awaiting_consent', ${key}, 'image/png', 4,
              ${createHash("sha256").update(docId).digest("hex")})`;
    storage.seed(key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const crossSite = await call(G.dataExportHandler, "/api/v1/me/export", {
      cookie: bogdan.S.cookie,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    const r = await call(G.dataExportHandler, "/api/v1/me/export", {
      cookie: bogdan.S.cookie,
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    const zip = Buffer.from(await r.arrayBuffer());
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const files = zipListing(zip);
    const all = files ? Object.values(files).join("\n") : zip.toString("latin1");
    // Datele lui Bogdan + cele comune din gospodăria Anei.
    expect(all).toContain("Pâine comună");
    expect(all).toContain("bogdan@exemplu.ro");
    // NU: contul personal al Anei, emailul Anei, parole, tokenuri.
    expect(all).not.toContain("Secretul Anei");
    expect(all).not.toContain("424242");
    expect(all).not.toContain("Personal Ana");
    expect(all).not.toContain("ana@exemplu.ro");
    expect(all).not.toMatch(/\$argon2/);
    expect(all).not.toContain(bogdan.S.bearer);
    expect(all).not.toMatch(/"token"|storageKey|token_hash/);
    if (files) {
      const names = Object.keys(files);
      expect(names).toContain("README.txt");
      expect(names).toContain("profil.json");
      expect(names).toContain("gospodarii/1/tranzactii.csv");
      expect(names).toContain(`gospodarii/1/fisiere/${docId}.png`);
      expect(names.filter((n) => n.endsWith("gospodarie.json"))).toHaveLength(2);
      // Fiecare JSON e valid.
      for (const n of names.filter((x) => x.endsWith(".json"))) {
        expect(() => JSON.parse(files[n]!), n).not.toThrow();
      }
      const profile = JSON.parse(files["profil.json"]!);
      expect(profile.user.email).toBe("bogdan@exemplu.ro");
      expect(Object.keys(profile.sessions[0]).sort()).toEqual(
        ["createdAt", "expiresAt", "ipAddress", "updatedAt", "userAgent"].sort(),
      );
    }
    // Auditat fără conținut.
    const [audit] = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events where action = 'user.data_exported' and actor_user_id = ${bogdan.id}`;
    expect(audit?.metadata).toEqual({ households: 2 });
  });

  it("previzualizarea și ștergerea: parola greșită → 400; fără „ȘTERGE” → 400; ultimul owner → 409; apoi succes și sesiunile închise", async () => {
    const prev = await call(G.deletionPreviewHandler, "/api/v1/me/deletion", {
      bearer: ana.S.bearer,
    });
    expect(prev.status).toBe(200);
    expect((await readJson(prev)).data).toMatchObject({
      hasPassword: true,
      platformAdmin: true,
      blockedHouseholds: [{ id: ana.hh }],
    });
    const wrong = await call(G.deleteAccountHandler, "/api/v1/me/delete", {
      bearer: ana.S.bearer,
      body: { password: "gresita-gresita", confirm: "ȘTERGE" },
    });
    expect(wrong.status).toBe(400);
    expect((await readJson(wrong)).error?.code).toBe("invalid_password");
    const noConfirm = await call(G.deleteAccountHandler, "/api/v1/me/delete", {
      bearer: ana.S.bearer,
      body: { password: PASS_A, confirm: "sterge" },
    });
    expect(noConfirm.status).toBe(400);
    const extra = await call(G.deleteAccountHandler, "/api/v1/me/delete", {
      bearer: ana.S.bearer,
      body: { password: PASS_A, confirm: "ȘTERGE", userId: bogdan.id },
    });
    expect(extra.status).toBe(400);
    const blocked = await call(G.deleteAccountHandler, "/api/v1/me/delete", {
      bearer: ana.S.bearer,
      body: { password: PASS_A, confirm: "ȘTERGE" },
    });
    // Ana e administratorul platformei (primul utilizator): refuz explicit, înaintea regulii L3.
    expect(blocked.status).toBe(409);
    expect((await readJson(blocked)).error?.code).toBe("platform_admin");

    // Bogdan (membru în casa Anei + propria casă) se șterge.
    const csrf = await call(G.deleteAccountHandler, "/api/v1/me/delete", {
      cookie: bogdan.S.cookie,
      headers: { origin: "https://atacator.invalid" },
      body: { password: PASS_B, confirm: "ȘTERGE" },
    });
    expect(csrf.status).toBe(403);
    const ok = await call(G.deleteAccountHandler, "/api/v1/me/delete", {
      cookie: bogdan.S.cookie,
      body: { password: PASS_B, confirm: "ȘTERGE" },
    });
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).data).toEqual({
      outcome: "deleted",
      deletedHouseholds: 1,
      leftHouseholds: 1,
    });
    // Sesiunile (cookie și bearer) nu mai funcționează.
    for (const init of [{ cookie: bogdan.S.cookie }, { bearer: bogdan.S.bearer }]) {
      expect((await call(G.deletionPreviewHandler, "/api/v1/me/deletion", init)).status).toBe(401);
    }
    // Contul comun creat de Bogdan rămâne al gospodăriei Anei.
    const [n] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.accounts where household_id = ${ana.hh} and owner_user_id is null`;
    expect(n?.n).toBe(1);
    // Gospodăria proprie a lui Bogdan și fișierul ei au dispărut.
    const [h] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.households where id = ${bogdan.hh}`;
    expect(h?.n).toBe(0);
    expect(storage.files.size).toBe(0);
    // Gospodăria Anei rămâne cu Ana singură; creatorul nu se schimbă.
    const hh2 = await withRlsOn(fx.db, { userId: ana.id }, (tx) =>
      createHousehold(tx, { name: "Încă una" }),
    );
    expect(hh2).toMatch(/^[0-9a-f-]{36}$/);
  });
});
