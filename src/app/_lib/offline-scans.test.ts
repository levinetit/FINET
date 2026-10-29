import { describe, expect, it, vi } from "vitest";

import {
  BACKOFF_MAX_MS,
  DAILY_LIMIT_RETRY_MS,
  MemoryScanStore,
  OFFLINE_MAX_ENTRIES,
  OFFLINE_MAX_TOTAL_BYTES,
  OFFLINE_TTL_MS,
  type QueuedScan,
  type UploadOutcome,
  backoffDelay,
  decide,
  enqueueProblem,
  flushScans,
  isQuotaError,
  nextDue,
  outcomeOf,
  ownerHeaders,
  purgeForeign,
  retryNow,
  uploadForm,
} from "./offline-scans";

/** Coada offline (ADR 0020) cu depozitul în memorie (aceeași interfață ca IndexedDB). */

const ANA = { userId: "u-ana", householdId: "h-ana" };
const MB = 1024 * 1024;
let seq = 0;

function scan(extra: Partial<QueuedScan> = {}): QueuedScan {
  seq++;
  return {
    id: `s${seq}`,
    userId: ANA.userId,
    householdId: ANA.householdId,
    createdAt: 1000 + seq,
    longReceipt: false,
    files: [{ type: "image/jpeg", size: 100, data: new Blob(["x"], { type: "image/jpeg" }) }],
    state: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    errorCode: null,
    ...extra,
  };
}

const response = (status: number, code: string | null = null): UploadOutcome => ({
  kind: "response",
  status,
  code,
});

describe("decizia după răspunsul serverului", () => {
  it("2xx (inclusiv 200 duplicat) → ștergere locală", () => {
    for (const s of [200, 201]) expect(decide(response(s), 1)).toEqual({ action: "delete" });
  });

  it("erori permanente → rămân vizibile cu motivul", () => {
    for (const [status, code] of [
      [400, "invalid_request"],
      [413, "file_too_large"],
      [415, "unsupported_type"],
      [422, "invalid_image"],
      [409, "storage_quota_exceeded"],
      [409, "long_receipt_duplicate"],
      [404, "not_found"],
    ] as const) {
      expect(decide(response(status, code), 1)).toEqual({ action: "fail", code });
    }
    expect(decide(response(400), 1)).toEqual({ action: "fail", code: "generic" });
  });

  it("401/403 (sesiune sau Access expirate) → așteaptă autentificarea", () => {
    expect(decide(response(401), 1)).toEqual({ action: "auth" });
    expect(decide(response(403, "forbidden"), 1)).toEqual({ action: "auth" });
  });

  it("rețea, 408, 429, 5xx → reîncercare cu pauză crescătoare; limita zilnică → peste o oră", () => {
    expect(decide({ kind: "network" }, 1)).toEqual({
      action: "retry",
      delayMs: 2000,
      code: "offline_network",
    });
    for (const s of [408, 429, 500, 502, 503]) {
      expect(decide(response(s), 3)).toEqual({
        action: "retry",
        delayMs: 8000,
        code: "offline_server",
      });
    }
    expect(decide(response(409, "daily_document_limit"), 1)).toEqual({
      action: "retry",
      delayMs: DAILY_LIMIT_RETRY_MS,
      code: "daily_document_limit",
    });
  });

  it("pauza: 2 s, 4 s, 8 s … plafonată la 5 minute", () => {
    expect([0, 1, 2, 3, 4].map(backoffDelay)).toEqual([2000, 2000, 4000, 8000, 16000]);
    expect(backoffDelay(50)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(Number.NaN)).toBe(2000);
  });
});

describe("salvarea locală", () => {
  it("doar JPEG/PNG, sub limita de fișier, cel mult 10 intrări și 50 MB", () => {
    const ok = [{ type: "image/jpeg", size: 1000 }];
    expect(enqueueProblem([], ok, 10 * MB)).toBeNull();
    expect(enqueueProblem([], [{ type: "image/png", size: 1 }], 10 * MB)).toBeNull();
    expect(enqueueProblem([], [], 10 * MB)).toBe("offline_type");
    for (const type of ["application/pdf", "image/webp", "image/heic", "text/html", ""]) {
      expect(enqueueProblem([], [{ type, size: 10 }], 10 * MB), type).toBe("offline_type");
    }
    expect(enqueueProblem([], [{ type: "image/jpeg", size: 10 * MB + 1 }], 10 * MB)).toBe(
      "offline_too_large",
    );
    expect(enqueueProblem([], [{ type: "image/jpeg", size: 0 }], 10 * MB)).toBe(
      "offline_too_large",
    );
    const full = Array.from({ length: OFFLINE_MAX_ENTRIES }, () => scan());
    expect(enqueueProblem(full, ok, 10 * MB)).toBe("offline_full");
    const heavy = [
      scan({
        files: [{ type: "image/jpeg", size: OFFLINE_MAX_TOTAL_BYTES - 500, data: new Blob([]) }],
      }),
    ];
    expect(enqueueProblem(heavy, ok, 10 * MB)).toBe("offline_space");
  });

  it("eroarea de cotă e recunoscută (Chromium/WebKit și Firefox)", async () => {
    const store = new MemoryScanStore();
    store.quotaBytes = 50;
    const error = await store.put(scan()).catch((e: unknown) => e);
    expect(isQuotaError(error)).toBe(true);
    expect(await store.list()).toEqual([]); // nimic scris pe jumătate
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaError(new Error("altceva"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it("corpul cererii: kind=receipt, longReceipt, pozele în ordine, nume generice", async () => {
    const files = [1, 2, 3].map((i) => ({
      type: "image/png",
      size: 1,
      data: new Blob([String(i)], { type: "image/png" }),
    }));
    const form = uploadForm(scan({ longReceipt: true, files }));
    expect(form.get("kind")).toBe("receipt");
    expect(form.get("longReceipt")).toBe("true");
    const parts = form.getAll("files") as File[];
    expect(parts.map((f) => f.name)).toEqual(["bon-1", "bon-2", "bon-3"]);
    expect(await Promise.all(parts.map((f) => f.text()))).toEqual(["1", "2", "3"]);
    expect(uploadForm(scan()).has("longReceipt")).toBe(false);
  });
});

describe("sincronizarea", () => {
  const deps = (upload: (s: QueuedScan) => Promise<UploadOutcome>, now = 10_000) => ({
    owner: ANA,
    now: () => now,
    upload,
  });

  it("se șterge local DOAR după confirmarea serverului; o eroare de rețea păstrează intrarea", async () => {
    const store = new MemoryScanStore();
    const a = scan();
    const b = scan();
    await store.put(a);
    await store.put(b);
    const upload = vi.fn(async (s: QueuedScan) =>
      s.id === a.id ? response(201) : ({ kind: "network" } as const),
    );
    const result = await flushScans(store, deps(upload));
    expect(result).toEqual({
      uploaded: 1,
      waiting: 1,
      failed: 0,
      needsAuth: false,
      ownerStale: false,
    });
    const [left] = await store.list();
    expect(left).toMatchObject({ id: b.id, state: "pending", attempts: 1, nextAttemptAt: 12_000 });
    expect(left!.errorCode).toBe("offline_network");
  });

  it("o încărcare care aruncă (excepție) e tratată ca eroare de rețea", async () => {
    const store = new MemoryScanStore();
    await store.put(scan());
    const result = await flushScans(
      store,
      deps(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(result.waiting).toBe(1);
  });

  it("al doilea răspuns e „duplicat” (200): tot ștergere, nimic încărcat de două ori", async () => {
    const store = new MemoryScanStore();
    const s = scan();
    await store.put(s);
    // Prima încercare a ajuns la server, dar răspunsul s-a pierdut.
    await flushScans(
      store,
      deps(async () => ({ kind: "network" })),
    );
    const upload = vi.fn(async () => response(200));
    await flushScans(store, deps(upload, 20_000));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
  });

  it("intrările nescadente nu se trimit; `nextDue` dă momentul următoarei încercări", async () => {
    const store = new MemoryScanStore();
    await store.put(scan({ nextAttemptAt: 50_000 }));
    const upload = vi.fn(async () => response(201));
    await flushScans(store, deps(upload));
    expect(upload).not.toHaveBeenCalled();
    expect(nextDue(await store.list(), ANA)).toBe(50_000);
    expect(nextDue([], ANA)).toBeNull();
  });

  it("eroare permanentă → `failed` cu motiv; „Reîncearcă” o pune înapoi, scadentă imediat", async () => {
    const store = new MemoryScanStore();
    await store.put(scan());
    const result = await flushScans(
      store,
      deps(async () => response(413, "file_too_large")),
    );
    expect(result).toMatchObject({ failed: 1, waiting: 0 });
    const [failed] = await store.list();
    expect(failed).toMatchObject({ state: "failed", errorCode: "file_too_large" });
    // Nu se reîncearcă singură.
    const upload = vi.fn(async () => response(201));
    await flushScans(store, deps(upload));
    expect(upload).not.toHaveBeenCalled();
    const back = retryNow(failed!, 99);
    expect(back).toMatchObject({ state: "pending", nextAttemptAt: 99, errorCode: null });
  });

  it("401 oprește trecerea (restul rămân neatinse) și cere autentificare", async () => {
    const store = new MemoryScanStore();
    await store.put(scan());
    await store.put(scan());
    const upload = vi.fn(async () => response(401));
    const result = await flushScans(store, deps(upload));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.needsAuth).toBe(true);
    expect((await store.list()).map((s) => s.state)).toEqual(["pending", "pending"]);
  });

  it("izolare: se încarcă DOAR intrările utilizatorului ȘI gospodăriei curente", async () => {
    const store = new MemoryScanStore();
    const mine = scan();
    const otherHousehold = scan({ householdId: "h-alta" });
    const otherUser = scan({ userId: "u-bogdan", householdId: "h-bogdan" });
    for (const s of [mine, otherHousehold, otherUser]) await store.put(s);
    const seen: string[] = [];
    await flushScans(
      store,
      deps(async (s) => {
        seen.push(s.id);
        return response(201);
      }),
    );
    expect(seen).toEqual([mine.id]);
    expect((await store.list()).map((s) => s.id).sort()).toEqual(
      [otherHousehold.id, otherUser.id].sort(),
    );
  });

  it("curățarea: intrările altor utilizatori și cele expirate pleacă; aceeași persoană, altă gospodărie rămâne", async () => {
    const store = new MemoryScanStore();
    const keep = scan({ createdAt: 1_000_000 });
    const keepOtherHousehold = scan({ householdId: "h-alta", createdAt: 1_000_000 });
    const foreign = scan({ userId: "u-bogdan", createdAt: 1_000_000 });
    const expired = scan({ createdAt: 1_000_000 - OFFLINE_TTL_MS - 1 });
    for (const s of [keep, keepOtherHousehold, foreign, expired]) await store.put(s);
    await purgeForeign(store, ANA.userId, 1_000_000);
    expect((await store.list()).map((s) => s.id).sort()).toEqual(
      [keep.id, keepOtherHousehold.id].sort(),
    );
  });
});

describe("proprietarul impus de server (409 owner_mismatch)", () => {
  const deps = (upload: (s: QueuedScan) => Promise<UploadOutcome>) => ({
    owner: ANA,
    now: () => 10_000,
    upload,
  });
  const mismatch = (reason: string) =>
    outcomeOf(409, { error: { code: "owner_mismatch", message: "x", reason } });

  it("fiecare încărcare trimite utilizatorul și gospodăria intrării", () => {
    const s = scan();
    expect(ownerHeaders(s)).toEqual({
      "X-FINET-Expected-User": ANA.userId,
      "X-FINET-Expected-Household": ANA.householdId,
    });
  });

  it("răspunsul → codul cozii: reason pentru conflicte, owner_mismatch după reason, doar [a-z_]", () => {
    expect(mismatch("user")).toEqual({
      kind: "response",
      status: 409,
      code: "owner_user_mismatch",
    });
    expect(mismatch("household")).toEqual({
      kind: "response",
      status: 409,
      code: "owner_household_mismatch",
    });
    expect(outcomeOf(409, { error: { code: "conflict", reason: "daily_document_limit" } })).toEqual(
      { kind: "response", status: 409, code: "daily_document_limit" },
    );
    expect(outcomeOf(413, { error: { code: "file_too_large" } })).toMatchObject({
      code: "file_too_large",
    });
    expect(outcomeOf(500, { error: { code: "<script>" } })).toMatchObject({ code: null });
    expect(outcomeOf(502, null)).toMatchObject({ code: null });
    expect(decide(mismatch("user"), 1)).toEqual({ action: "foreign", sameUser: false });
    expect(decide(mismatch("household"), 1)).toEqual({ action: "foreign", sameUser: true });
  });

  it("alt utilizator → intrarea se șterge, nu se retrimite, trecerea se oprește", async () => {
    const store = new MemoryScanStore();
    const a = scan();
    const b = scan();
    await store.put(a);
    await store.put(b);
    const upload = vi.fn(async () => mismatch("user"));
    const result = await flushScans(store, deps(upload));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.ownerStale).toBe(true);
    expect((await store.list()).map((s) => s.id)).toEqual([b.id]);
  });

  it("aceeași persoană, altă gospodărie activă → păstrată (pentru după comutare), fără retrimitere imediată", async () => {
    const store = new MemoryScanStore();
    const a = scan();
    await store.put(a);
    const upload = vi.fn(async () => mismatch("household"));
    const result = await flushScans(store, deps(upload));
    expect(result.ownerStale).toBe(true);
    const [kept] = await store.list();
    expect(kept).toMatchObject({
      id: a.id,
      state: "pending",
      errorCode: "owner_household_mismatch",
      nextAttemptAt: 12_000,
    });
    // Nu e scadentă imediat: a doua trecere în același moment nu o retrimite.
    await flushScans(store, deps(upload));
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
