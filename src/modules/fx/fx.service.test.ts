import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { handleFxRefresh } from "@/worker/fx/fx-jobs";

import { ECB_HISTORY_URL } from "./ecb";
import { countRates, latestRates, refreshRates, upsertRates } from "./fx.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Cursurile BCE pe PostgreSQL real, ca `finet_app` (ADR 0049): prima rulare ia istoricul (tabel
 * gol), următoarele doar ziua curentă; upsert-ul rescrie cursul aceleiași zile; `latestRates`
 * întoarce ziua cea mai recentă ≤ data cerută, cu EUR = 1.000.000; fără rânduri → null.
 */

const day = (date: string, ron: string, usd = "1.0856") =>
  `<Cube time='${date}'><Cube currency='USD' rate='${usd}'/><Cube currency='RON' rate='${ron}'/><Cube currency='JPY' rate='160'/></Cube>`;
const HIST = `<Cube>${day("2026-10-26", "4.95")}${day("2026-10-27", "4.96")}</Cube>`;
const DAILY = `<Cube>${day("2026-10-28", "4.97")}</Cube>`;

describe.skipIf(!TEST_ADMIN_URL)("fx_rates (Postgres real, finet_app)", () => {
  let fx: AuthFixture;
  const urls: string[] = [];
  const download = async (url: string) => {
    urls.push(url);
    return url === ECB_HISTORY_URL ? HIST : DAILY;
  };

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_fx_rates");
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("tabel gol → istoricul; apoi doar ziua curentă; upsert idempotent", async () => {
    expect(await latestRates(fx.db)).toBeNull();
    const first = await refreshRates({
      db: fx.db,
      download,
      now: () => new Date("2026-10-28T16:00:00Z"),
    });
    expect(first).toEqual({ source: "history", parsed: 4, upserted: 4 });
    expect(urls).toEqual([ECB_HISTORY_URL]);
    expect(await countRates(fx.db)).toBe(4);
    const second = await refreshRates({ db: fx.db, download });
    expect(second).toEqual({ source: "daily", parsed: 2, upserted: 2 });
    expect(await countRates(fx.db)).toBe(6);
    // Aceeași zi din nou: rescrie, nu dublează.
    await upsertRates(
      fx.db,
      [{ date: "2026-10-28", currency: "RON", rateMicro: 4_980_000n }],
      new Date(),
    );
    expect(await countRates(fx.db)).toBe(6);
  });

  it("latestRates: cea mai recentă zi ≤ data cerută, EUR implicit", async () => {
    const latest = await latestRates(fx.db);
    expect(latest?.date).toBe("2026-10-28");
    expect(latest?.rates.get("RON")).toBe(4_980_000n);
    expect(latest?.rates.get("USD")).toBe(1_085_600n);
    expect(latest?.rates.get("EUR")).toBe(1_000_000n);
    expect(latest?.rates.has("JPY" as never)).toBe(false);
    const older = await latestRates(fx.db, "2026-10-26");
    expect(older?.date).toBe("2026-10-26");
    expect(older?.rates.get("RON")).toBe(4_950_000n);
    expect(await latestRates(fx.db, "2020-01-01")).toBeNull();
  });

  it("jobul workerului loghează doar contoare", async () => {
    const events: Record<string, unknown>[] = [];
    const r = await handleFxRefresh({ db: fx.db, download, log: (e) => void events.push(e) });
    expect(r.source).toBe("daily");
    expect(events).toEqual([{ job: "fx.refresh", source: "daily", parsed: 2, upserted: 2 }]);
  });
});
