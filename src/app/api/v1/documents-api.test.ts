import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { LocalStorage } from "@/lib/storage";
import { type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { HOSTILE, multipartRequest, receiptLikeImage } from "@/modules/documents/testing";

import { type DocumentsApiDeps, uploadDocumentsHandler } from "./_lib/documents-handlers";
import { type Sessions, readJson, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Handlerul de încărcare (F6-A; ruta publică vine în F6-C): sesiune obligatorie, gospodăria din
 * sesiune, erorile de încărcare cu cod stabil și mesaj în română, rate limiting propriu.
 */
describe.skipIf(!TEST_ADMIN_URL)("încărcarea documentelor prin handler (F6-A)", () => {
  const PASS = "parola-de-test-lunga-123";
  let fx: AuthFixture;
  let env: DocumentsApiDeps;
  let A: Sessions;
  let root: string;

  const send = async (
    parts: Parameters<typeof multipartRequest>[0],
    headers: Record<string, string>,
    deps: DocumentsApiDeps = env,
  ) => {
    const res = await uploadDocumentsHandler(await multipartRequest(parts, headers), deps);
    return { status: res.status, body: await readJson(res) };
  };

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_documents_api");
    root = await realpath(await mkdtemp(join(tmpdir(), "finet-docs-api-")));
    env = {
      ...authEnv(fx.db),
      storage: new LocalStorage(root),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
    };
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
  });
  afterAll(async () => {
    await fx?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("fără sesiune → 401, nimic stocat", async () => {
    const r = await send([["files", await receiptLikeImage()]], {});
    expect(r.status).toBe(401);
    expect(await readdir(root)).toEqual([]);
  });

  it("201 la creare, 200 la duplicat (același document)", async () => {
    const jpg = await receiptLikeImage({ seed: 9 });
    const auth = { authorization: `Bearer ${A.bearer}` };
    const first = await send([["files", jpg, "bon.jpg"]], auth);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const data = first.body.data as {
      documents: { id: string; status: string; duplicate: boolean }[];
      created: number;
    };
    expect(data.created).toBe(1);
    expect(data.documents[0]).toMatchObject({ status: "awaiting_consent", duplicate: false });
    const again = await send([["files", jpg, "alt.jpg"]], auth);
    expect(again.status).toBe(200);
    expect((again.body.data as typeof data).documents[0]).toMatchObject({
      id: data.documents[0]!.id,
      duplicate: true,
    });
  });

  it("conținut ostil → 415 cu cod stabil și mesaj fără ecou", async () => {
    const r = await send([["files", HOSTILE[0]![1], "bon.jpg", "image/jpeg"]], {
      authorization: `Bearer ${A.bearer}`,
    });
    expect(r.status).toBe(415);
    expect(r.body.error?.code).toBe("unsupported_type");
    expect(JSON.stringify(r.body)).not.toContain("script");
  });

  it("HEIC → 415 heic_unsupported, cu sfatul de conversie", async () => {
    const heic = HOSTILE.find(([label]) => label === "HEIC")![1];
    const r = await send([["files", heic, "IMG_0001.HEIC"]], {
      authorization: `Bearer ${A.bearer}`,
    });
    expect([r.status, r.body.error?.code]).toEqual([415, "heic_unsupported"]);
    expect(r.body.error?.message).toContain("JPEG");
  });

  it("limita proprie de încărcări → 429 cu Retry-After", async () => {
    const strict: DocumentsApiDeps = {
      ...env,
      limits: { ...env.limits, documentUpload: { max: 1, windowSeconds: 600 } },
    };
    const auth = { authorization: `Bearer ${A.bearer}` };
    await send([["files", await receiptLikeImage({ seed: 30 })]], auth, strict);
    const res = await uploadDocumentsHandler(
      await multipartRequest([["files", await receiptLikeImage({ seed: 31 })]], auth),
      strict,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
