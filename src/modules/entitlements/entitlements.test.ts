import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig, resetConfigForTests } from "@/lib/config";
import { NotImplementedError } from "@/lib/errors";
import {
  can,
  createEntitlements,
  limit,
  type Feature,
  type LimitKey,
} from "@/modules/entitlements";

const HH = "00000000-0000-4000-8000-000000000001";

const limits = parseConfig({
  APP_MODE: "personal",
  NODE_ENV: "test",
  AI_DAILY_DOCUMENT_LIMIT: "7",
  AI_MONTHLY_BUDGET: "25",
  AI_MONTHLY_BUDGET_CURRENCY: "EUR",
  STORAGE_QUOTA_MB: "1234",
});

describe("entitlements în modul personal", () => {
  const e = createEntitlements("personal", limits);

  it("can → true pentru orice funcție", async () => {
    await expect(e.can(HH, "documents.process")).resolves.toBe(true);
    await expect(e.can(HH, "budgets.max")).resolves.toBe(true);
  });

  it("limit → doar limitele tehnice din configurație", async () => {
    await expect(e.limit(HH, "ai.dailyDocuments")).resolves.toBe(7);
    await expect(e.limit(HH, "ai.monthlyBudget")).resolves.toEqual({
      amountMinor: 2500n,
      currency: "EUR",
    });
    await expect(e.limit(HH, "storage.quotaMb")).resolves.toBe(1234);
  });

  it("respinge o limită necunoscută", async () => {
    await expect(e.limit(HH, "budgets.max" as LimitKey)).rejects.toBeInstanceOf(TypeError);
  });

  it("respinge un householdId lipsă și o funcție malformată", async () => {
    await expect(e.can("", "documents.process")).rejects.toBeInstanceOf(TypeError);
    await expect(e.limit("  ", "storage.quotaMb")).rejects.toBeInstanceOf(TypeError);
    await expect(e.can(HH, "documents" as Feature)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("entitlements în modul saas", () => {
  const e = createEntitlements("saas", limits);

  it("aruncă NotImplementedError explicit (fără planuri simulate)", async () => {
    await expect(e.can(HH, "documents.process")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(e.limit(HH, "storage.quotaMb")).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe("funcțiile can/limit legate de configurația procesului", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTests();
  });

  it("folosesc APP_MODE și limitele din mediu", async () => {
    vi.stubEnv("APP_MODE", "personal");
    vi.stubEnv("STORAGE_QUOTA_MB", "42");
    resetConfigForTests();
    await expect(can(HH, "documents.process")).resolves.toBe(true);
    await expect(limit(HH, "storage.quotaMb")).resolves.toBe(42);
  });
});
