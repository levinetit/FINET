import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";

import { TooManyLinesError } from "./prices.repo";
import { getInflation, getSeries, guardScan, listProducts } from "./prices.service";
import { seedReceipt } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("guardScan (fără bază)", () => {
  it("plafonul de linii devine conflict cu cod fix, fără conținut", async () => {
    await expect(guardScan(() => Promise.reject(new TooManyLinesError()))).rejects.toMatchObject({
      reason: "too_many_lines",
    });
    await expect(guardScan(() => Promise.reject(new TooManyLinesError()))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(guardScan(() => Promise.reject(new Error("altceva")))).rejects.toThrow("altceva");
  });
});

describe.skipIf(!TEST_ADMIN_URL)("prețuri și inflație (Postgres real, finet_app)", () => {
  let f: FamilyFixture;
  let common: string;
  let personalC: string;
  let hb: string;
  const now = () => new Date("2026-10-29T10:00:00Z");
  const deps = () => ({ db: f.db, now });
  const LIDL = { merchant: "LIDL DISCOUNT SRL", cui: "RO22891860" };
  const KAUF = { merchant: "KAUFLAND ROMANIA SCS", cui: "RO15991149" };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_prices");
    common = (
      await createAccount(f.deps, f.A, f.HA, { name: "Comun", type: "bank", currency: "RON" })
    ).id;
    personalC = (
      await createAccount(f.deps, f.C, f.HA, {
        name: "Personal C",
        type: "bank",
        currency: "RON",
        ownerUserId: f.C.userId,
      })
    ).id;
    hb = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" })).id;
    const A = { householdId: f.HA, actorId: f.A.userId };
    const milk = (on: string, totalMinor: number, store = LIDL, account = common, actor = A) =>
      seedReceipt(f.admin, {
        ...actor,
        accountId: account,
        on,
        ...store,
        lines: [{ name: "LAPTE ZUZU 1,5% 1L", quantity: "1", totalMinor }],
      });
    // Perioada curentă (iulie–octombrie 2026) și perioada de bază (aceleași luni, 2025)
    for (const [on, price] of [
      ["2025-08-10", 700],
      ["2025-09-12", 720],
      ["2026-08-11", 790],
      ["2026-09-10", 810],
      ["2026-10-09", 800],
    ] as const) {
      await milk(on, price);
    }
    // Kaufland, mai ieftin: 2 observații
    await milk("2026-09-20", 700, KAUF);
    await milk("2026-10-20", 720, KAUF);
    // Bon pe contul PERSONAL al lui C la prețuri foarte diferite: invizibil pentru A
    await milk("2026-10-21", 100, KAUF, personalC, { householdId: f.HA, actorId: f.C.userId });
    await milk("2026-10-22", 100, KAUF, personalC, { householdId: f.HA, actorId: f.C.userId });
    await milk("2026-10-23", 100, KAUF, personalC, { householdId: f.HA, actorId: f.C.userId });
    // Neconfirmat și altă gospodărie: nu intră
    await seedReceipt(f.admin, {
      ...A,
      accountId: common,
      on: "2026-10-24",
      status: "needs_review",
      ...LIDL,
      lines: [{ name: "LAPTE ZUZU 1,5% 1L", totalMinor: 1 }],
    });
    await seedReceipt(f.admin, {
      householdId: f.HB,
      actorId: f.B.userId,
      accountId: hb,
      on: "2026-10-12",
      ...LIDL,
      lines: [{ name: "LAPTE ZUZU 1,5% 1L", totalMinor: 9999 }],
    });
    // Un produs cu prea puține date, unul ambiguu, unul cu reducere (nu e linie de produs)
    await seedReceipt(f.admin, {
      ...A,
      accountId: common,
      on: "2026-10-05",
      ...LIDL,
      lines: [
        { name: "UNT 200G", totalMinor: 899 },
        { name: "APA 2L 6 BUC", totalMinor: 1000 },
        { name: "REDUCERE CARD", totalMinor: 300, kind: "discount" },
        { name: "PUNGA RAFIE", totalMinor: 50, kind: "bag" },
      ],
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  it("produse: prag de date, preț mediu, cel mai ieftin comerciant (fără bonul personal al altui membru)", async () => {
    const r = await listProducts(deps(), f.A, f.HA);
    expect(r.excludedLines).toBe(1); // apa 2L 6 BUC
    const milk = r.products.find((p) => p.name === "lapte zuzu 1.5%")!;
    // A vede: Lidl 5 bonuri (2025-08 … 2026-10, dar fereastra implicită = 12 luni → 2025-11…),
    // deci doar cele 3 din 2026 + 2 Kaufland; fără cele 3 ale lui C (cont personal)
    expect(milk).toMatchObject({ enough: true, unit: "l", currency: "RON", observations: 5 });
    const lidl = milk.merchants.find((m) => m.merchantKey === "22891860")!;
    const kauf = milk.merchants.find((m) => m.merchantKey === "15991149")!;
    expect(lidl).toMatchObject({ observations: 3, priceMinor: 800n }); // (790+810+800)/3
    expect(kauf).toMatchObject({ observations: 2, priceMinor: 710n });
    expect(milk.cheapest!.cheapest.merchantKey).toBe("15991149");
    expect(milk.cheapest!.mostUsed.merchantKey).toBe("22891860");
    expect(milk.cheapest!.diffMinor).toBe(90n);
    // C vede și cele 3 linii ale contului lui personal
    const asC = await listProducts(deps(), f.C, f.HA);
    const milkC = asC.products.find((p) => p.name === "lapte zuzu 1.5%")!;
    expect(milkC.observations).toBe(8);
    expect(milkC.merchants.find((m) => m.merchantKey === "15991149")!.observations).toBe(5);
    // O singură observație (untul): sub prag, fără prețuri
    const butter = r.products.find((p) => p.name === "unt")!;
    expect(butter).toMatchObject({
      enough: false,
      priceMinor: null,
      cheapest: null,
      observations: 1,
    });
    // doar cele cu date suficiente / căutare / prag configurabil / monedă
    expect(
      (await listProducts(deps(), f.A, f.HA, { onlyEnough: true })).products.map((p) => p.name),
    ).toEqual(["lapte zuzu 1.5%"]);
    expect(
      (await listProducts(deps(), f.A, f.HA, { search: "UNT" })).products.map((p) => p.name),
    ).toEqual(["unt"]);
    const lenient = await listProducts(deps(), f.A, f.HA, { minObservations: 1, minMonths: 1 });
    expect(lenient.products.find((p) => p.name === "unt")!.enough).toBe(true);
    expect((await listProducts(deps(), f.A, f.HA, { currency: "EUR" })).products).toEqual([]);
    // Ferestre: 2 luni → fără septembrie 2025 etc.
    const short = await listProducts(deps(), f.A, f.HA, { months: 1 });
    expect(short.from).toBe("2026-10-01");
    expect(short.products.find((p) => p.name === "lapte zuzu 1.5%")!.enough).toBe(false);
  });

  it("izolare: altă gospodărie, parametri invalizi, 404", async () => {
    const b = await listProducts(deps(), f.B, f.HB);
    expect(b.products.find((p) => p.name === "lapte zuzu 1.5%")!.observations).toBe(1);
    await expect(listProducts(deps(), f.B, f.HA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listProducts(deps(), f.A, f.HA, { months: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listProducts(deps(), f.A, f.HA, { limit: 9999 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(listProducts(deps(), f.A, f.HA, { necunoscut: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("serie lunară pe comerciant; produs inexistent → null", async () => {
    const s = await getSeries(deps(), f.A, f.HA, { product: "l|lapte zuzu 1.5%", months: 14 });
    expect(s!.series.enough).toBe(true);
    // fereastra de 14 luni începe la 1 sept. 2025: iulie–august 2025 sunt în afară
    expect(s!.series.overall.map((p) => p.bucket)).toEqual([
      "2025-09",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(s!.series.byMerchant.map((m) => m.merchantKey)).toEqual(["15991149", "22891860"]);
    const weekly = await getSeries(deps(), f.A, f.HA, {
      product: "l|lapte zuzu 1.5%",
      granularity: "week",
    });
    expect(weekly!.series.overall.map((p) => p.bucket)).toContain("2026-10-05");
    expect(await getSeries(deps(), f.A, f.HA, { product: "l|nimic" })).toBeNull();
    await expect(getSeries(deps(), f.A, f.HA, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("inflația: luni vs. același interval cu un an în urmă, doar articolele din ambele perioade", async () => {
    // curent (iul–oct 2026, 3 luni = ago–oct): Lidl 790, 810, 800; bază (ago–oct 2025): 700, 720
    const r = await getInflation(deps(), f.A, f.HA, {
      months: 3,
      baseline: "year_ago",
      minItems: 1,
    });
    expect(r.current).toEqual({ from: "2026-08-01", to: "2026-10-29" });
    expect(r.base).toEqual({ from: "2025-08-01", to: "2025-10-29" });
    const ron = r.currencies.find((c) => c.currency === "RON")!;
    expect(ron.status).toBe("ok");
    expect(ron.itemsUsed).toBe(1);
    // Lidl: bază (700+720)/2 = 710; curent (790+810+800)/3 = 800 → +12,68 % → 1268 pb
    expect(ron.items[0]).toMatchObject({
      merchantKey: "22891860",
      basePriceMinor: 710n,
      currentPriceMinor: 800n,
      changeBps: 1268n,
    });
    expect(ron.changeBps).toBe(1268n);
    // Prag implicit de articole (5): fără variație
    const strict = await getInflation(deps(), f.A, f.HA, { months: 3, baseline: "year_ago" });
    expect(strict.currencies.find((c) => c.currency === "RON")).toMatchObject({
      status: "insufficient",
      changeBps: null,
      items: [],
    });
    // Kaufland n-are bază: nu apare ca articol
    expect(ron.items.map((i) => i.merchantKey)).toEqual(["22891860"]);
    await expect(getInflation(deps(), f.A, f.HA, { months: 13 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("inflația față de lunile imediat anterioare", async () => {
    const r = await getInflation(deps(), f.A, f.HA, {
      months: 1,
      baseline: "previous",
      minItems: 1,
      minObservations: 1,
    });
    expect(r.base).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(r.current).toEqual({ from: "2026-10-01", to: "2026-10-29" });
    const ron = r.currencies.find((c) => c.currency === "RON")!;
    // Lidl: sept 810 → oct 800 (-1,23 %); Kaufland: sept 700 → oct 720 (+2,86 %), fără bonurile personale
    const byMerchant = Object.fromEntries(ron.items.map((i) => [i.merchantKey, i.changeBps]));
    expect(byMerchant).toEqual({ "22891860": -123n, "15991149": 286n });
  });
});
