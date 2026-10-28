import { describe, expect, it } from "vitest";

import {
  RECURRING_FREQUENCIES,
  RECURRING_MAX_INTERVAL,
  RECURRING_MAX_OCCURRENCES,
  RECURRING_STATUSES,
  RECURRING_TYPES,
} from "@/db/schema";
import {
  RECURRING_DESCRIPTION_MAX,
  RECURRING_MERCHANT_MAX,
} from "@/modules/recurring/recurring.schema";
import type { RecurringRuleJson } from "@/modules/recurring/recurring.schema";

import {
  RECURRING_LIMITS,
  UI_RECURRING_FREQUENCIES,
  UI_RECURRING_STATUSES,
  UI_RECURRING_TYPES,
  isPausedByArchivedAccount,
  type RecurringFormValues,
  recurringFormBody,
  ruleSummary,
  scheduleText,
  statusFilterOf,
  statusLabel,
} from "./recurring-ui";

const ACC = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";

const form = (over: Partial<RecurringFormValues> = {}): RecurringFormValues => ({
  description: "  Chirie   apartament ",
  merchant: "",
  type: "expense",
  accountId: ACC,
  categoryId: "",
  amount: "1.250,50",
  frequency: "monthly",
  interval: "",
  dayOfMonth: "",
  startOn: "2026-07-31",
  endOn: "",
  maxOccurrences: "",
  ...over,
});

const rule = (over: Partial<RecurringRuleJson> = {}): RecurringRuleJson => ({
  id: ACC,
  accountId: ACC,
  categoryId: null,
  type: "expense",
  amountMinor: 125050,
  currency: "RON",
  description: "Chirie",
  merchant: null,
  frequency: "monthly",
  interval: 1,
  dayOfMonth: 31,
  startOn: "2026-07-31",
  nextRunOn: "2026-11-30",
  endOn: null,
  maxOccurrences: null,
  occurrencesCount: 4,
  status: "active",
  due: false,
  lastErrorCode: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("plățile recurente în interfață", () => {
  it("listele și limitele sunt aceleași cu ale bazei și ale serviciului", () => {
    expect([...UI_RECURRING_TYPES].sort()).toEqual([...RECURRING_TYPES].sort());
    expect([...UI_RECURRING_FREQUENCIES].sort()).toEqual([...RECURRING_FREQUENCIES].sort());
    expect([...UI_RECURRING_STATUSES]).toEqual([...RECURRING_STATUSES]);
    expect(RECURRING_LIMITS).toEqual({
      description: RECURRING_DESCRIPTION_MAX,
      merchant: RECURRING_MERCHANT_MAX,
      interval: RECURRING_MAX_INTERVAL,
      maxOccurrences: RECURRING_MAX_OCCURRENCES,
    });
  });

  it("filtrul de stare din URL: doar valorile cunoscute", () => {
    expect(statusFilterOf("paused")).toBe("paused");
    expect(statusFilterOf(["completed", "active"])).toBe("completed");
    expect(statusFilterOf("x")).toBe("all");
    expect(statusFilterOf(undefined)).toBe("all");
  });

  it("pusă pe pauză din cauza contului arhivat: doar `paused` + `account_archived`", () => {
    expect(
      isPausedByArchivedAccount(rule({ status: "paused", lastErrorCode: "account_archived" })),
    ).toBe(true);
    expect(statusLabel(rule({ status: "paused", lastErrorCode: "account_archived" }))).toBe(
      "Pusă pe pauză (cont arhivat)",
    );
    expect(isPausedByArchivedAccount(rule({ status: "paused" }))).toBe(false);
    expect(statusLabel(rule({ status: "paused" }))).toBe("Pusă pe pauză");
    expect(
      isPausedByArchivedAccount(rule({ status: "active", lastErrorCode: "account_archived" })),
    ).toBe(false);
  });

  it("descrierea calendarului, suma `0,00 lei` și data `zz.ll.aaaa`", () => {
    expect(scheduleText(rule())).toBe("în fiecare lună, în ziua 31");
    expect(scheduleText(rule({ frequency: "weekly", interval: 2, dayOfMonth: null }))).toBe(
      "la fiecare 2 săptămâni",
    );
    const text = ruleSummary(rule());
    expect(text).toContain("1.250,50");
    expect(text).toContain("30.11.2026");
    expect(text).toContain("4 tranzacții generate");
    expect(ruleSummary(rule({ maxOccurrences: 12 }))).toContain("4 din 12 rate");
    expect(ruleSummary(rule({ status: "completed" }))).toContain("fără scadențe rămase");
  });

  it("formularul de creare: corpul cererii cu suma ca întreg în bani", () => {
    const r = recurringFormBody(form(), "RON", "create");
    expect(r).toEqual({
      ok: true,
      body: {
        accountId: ACC,
        categoryId: null,
        amountMinor: 125050,
        description: "Chirie apartament",
        merchant: null,
        frequency: "monthly",
        interval: 1,
        endOn: null,
        maxOccurrences: null,
        type: "expense",
        startOn: "2026-07-31",
      },
    });
    const withDay = recurringFormBody(
      form({ dayOfMonth: "15", maxOccurrences: "24" }),
      "RON",
      "create",
    );
    expect(withDay.ok && withDay.body).toMatchObject({ dayOfMonth: 15, maxOccurrences: 24 });
    // Ziua nu se trimite la săptămânal.
    const weekly = recurringFormBody(
      form({ frequency: "weekly", dayOfMonth: "15" }),
      "RON",
      "create",
    );
    expect(weekly.ok && "dayOfMonth" in weekly.body).toBe(false);
  });

  it("formularul: aceleași limite ca serverul, mesaje în română", () => {
    const bad = recurringFormBody(
      form({
        description: " ",
        amount: "0",
        interval: "101",
        dayOfMonth: "32",
        maxOccurrences: "1201",
        endOn: "2026-07-01",
        accountId: "",
      }),
      "RON",
      "create",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.fields).sort()).toEqual(
        [
          "accountId",
          "amount",
          "dayOfMonth",
          "description",
          "endOn",
          "interval",
          "maxOccurrences",
        ].sort(),
      );
      expect(bad.fields.interval).toBe("Intervalul e un număr întreg între 1 și 100.");
      expect(bad.fields.maxOccurrences).toBe("Numărul de rate e un număr întreg între 1 și 1200.");
    }
    const noStart = recurringFormBody(form({ startOn: "" }), "RON", "create");
    expect(!noStart.ok && noStart.fields.startOn).toBe("Alege data de început.");
    expect(
      recurringFormBody(form({ interval: "100", maxOccurrences: "1200" }), "RON", "create").ok,
    ).toBe(true);
  });

  it("formularul de editare: fără `type`/`startOn`, cu `null` explicit pentru câmpurile golite", () => {
    const r = recurringFormBody(form({ startOn: "" }), "RON", "edit");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body).not.toHaveProperty("type");
      expect(r.body).not.toHaveProperty("startOn");
      expect(r.body).toMatchObject({
        dayOfMonth: null,
        endOn: null,
        maxOccurrences: null,
        merchant: null,
      });
    }
  });
});
