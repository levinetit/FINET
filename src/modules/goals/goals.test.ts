import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ValidationError } from "@/lib/errors";
import { createAccount, deleteAccount } from "@/modules/accounts/accounts.service";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";

import { goalToJson } from "./goals.schema";
import {
  contributeToGoal,
  createGoal,
  deleteGoal,
  deriveStatus,
  getGoal,
  listGoals,
  updateGoal,
} from "./goals.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("deriveStatus", () => {
  it("atins ⇔ economisit ≥ țintă; abandonat rămâne abandonat", () => {
    expect(deriveStatus("active", 99n, 100n)).toBe("active");
    expect(deriveStatus("active", 100n, 100n)).toBe("achieved");
    expect(deriveStatus("achieved", 99n, 100n)).toBe("active");
    expect(deriveStatus("abandoned", 500n, 100n)).toBe("abandoned");
  });
});

describe.skipIf(!TEST_ADMIN_URL)("obiective (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let eur: string;
  let accB: string;

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_goals");
    ron = (
      await createAccount(f.deps, f.A, f.HA, { name: "Econ", type: "savings", currency: "RON" })
    ).id;
    eur = (await createAccount(f.deps, f.A, f.HA, { name: "EUR", type: "bank", currency: "EUR" }))
      .id;
    accB = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" }))
      .id;
  });
  afterAll(async () => {
    await f?.close();
  });

  const add = (id: string, amountMinor: number) =>
    contributeToGoal(f.deps, f.A, f.HA, id, { direction: "add", amountMinor });
  const withdraw = (id: string, amountMinor: number) =>
    contributeToGoal(f.deps, f.A, f.HA, id, { direction: "withdraw", amountMinor });

  it("creare: validare, cont din altă gospodărie → 404, alt fel de monedă → 400", async () => {
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: " Vacanța 2027 ",
      target: "5.000,00",
      currency: "RON",
      deadline: "2027-07-01",
      accountId: ron,
    });
    expect(g).toMatchObject({
      name: "Vacanța 2027",
      targetMinor: 500_000n,
      savedMinor: 0n,
      status: "active",
      progressPct: 0,
      accountId: ron,
    });
    await expect(
      createGoal(f.deps, f.A, f.HA, {
        name: "X",
        targetMinor: 1,
        currency: "RON",
        accountId: accB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createGoal(f.deps, f.A, f.HA, { name: "X", targetMinor: 1, currency: "RON", accountId: eur }),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const bad of [
      { name: "X", targetMinor: 0, currency: "RON" },
      { name: "X", targetMinor: 10_000_000_000_001, currency: "RON" },
      { name: "", targetMinor: 1, currency: "RON" },
      { name: "X", targetMinor: 1, target: "1", currency: "RON" },
      { name: "X", targetMinor: 1, currency: "RON", deadline: "2027-02-30" },
      { name: "X", targetMinor: 1, currency: "RON", savedMinor: 5 },
      { name: "X", targetMinor: 1, currency: "RON", status: "achieved" },
      { name: "X", targetMinor: 1, currency: "RON", householdId: f.HB },
    ]) {
      await expect(createGoal(f.deps, f.A, f.HA, bad), JSON.stringify(bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("contribuții: progres, atins la țintă, reversibil la retragere, nu sub 0, plafon", async () => {
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "Laptop",
      targetMinor: 1_000,
      currency: "RON",
    });
    expect((await add(g.id, 333)).progressPct).toBe(33);
    const reached = await add(g.id, 667);
    expect(reached).toMatchObject({ savedMinor: 1_000n, status: "achieved", progressPct: 100 });
    expect((await add(g.id, 500)).progressPct).toBe(150);
    const back = await withdraw(g.id, 501);
    expect(back).toMatchObject({ savedMinor: 999n, status: "active", progressPct: 99 });
    await expect(withdraw(g.id, 1_000)).rejects.toMatchObject({ reason: "goal_saved_negative" });
    expect((await getGoal(f.deps, f.A, f.HA, g.id)).savedMinor).toBe(999n);
    expect((await withdraw(g.id, 999)).savedMinor).toBe(0n);
    // Plafonul economisitului = plafonul sumelor (10^13).
    await add(g.id, 10_000_000_000_000);
    await expect(add(g.id, 1)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      contributeToGoal(f.deps, f.A, f.HA, g.id, { direction: "add", amountMinor: -5 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(goalToJson(await getGoal(f.deps, f.A, f.HA, g.id))).toMatchObject({
      savedMinor: 10_000_000_000_000,
      targetMinor: 1_000,
    });
  });

  it("schimbarea țintei recalculează starea; abandonat manual îngheață contribuțiile; reluare", async () => {
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "Mașină",
      targetMinor: 1_000,
      currency: "RON",
    });
    await add(g.id, 800);
    expect((await updateGoal(f.deps, f.A, f.HA, g.id, { targetMinor: 800 })).status).toBe(
      "achieved",
    );
    expect((await updateGoal(f.deps, f.A, f.HA, g.id, { target: "9,00" })).status).toBe("active");
    const ab = await updateGoal(f.deps, f.A, f.HA, g.id, { status: "abandoned" });
    expect(ab.status).toBe("abandoned");
    await expect(add(g.id, 1)).rejects.toMatchObject({ reason: "goal_abandoned" });
    // Ținta nouă nu scoate din „abandonat”.
    expect((await updateGoal(f.deps, f.A, f.HA, g.id, { targetMinor: 100 })).status).toBe(
      "abandoned",
    );
    expect((await updateGoal(f.deps, f.A, f.HA, g.id, { status: "active" })).status).toBe(
      "achieved",
    );
    await expect(
      updateGoal(f.deps, f.A, f.HA, g.id, { status: "achieved" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(updateGoal(f.deps, f.A, f.HA, g.id, { currency: "EUR" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await listGoals(f.deps, f.A, f.HA, { status: "achieved" })).map((x) => x.id)).toContain(
      g.id,
    );
  });

  it("contul legat: ștergerea contului gol desface legătura; schimbarea contului verifică moneda", async () => {
    const tmp = (
      await createAccount(f.deps, f.A, f.HA, { name: "Tmp", type: "cash", currency: "RON" })
    ).id;
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "Fond",
      targetMinor: 10,
      currency: "RON",
      accountId: tmp,
    });
    await deleteAccount(f.deps, f.A, f.HA, tmp);
    expect((await getGoal(f.deps, f.A, f.HA, g.id)).accountId).toBeNull();
    await expect(updateGoal(f.deps, f.A, f.HA, g.id, { accountId: eur })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await updateGoal(f.deps, f.A, f.HA, g.id, { accountId: ron })).accountId).toBe(ron);
  });

  it("izolare: B nu vede, nu modifică, nu contribuie și nu șterge obiectivele lui A; C (member) le vede", async () => {
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "Secret",
      targetMinor: 10,
      currency: "RON",
    });
    await expect(getGoal(f.deps, f.B, f.HB, g.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getGoal(f.deps, f.B, f.HA, g.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateGoal(f.deps, f.B, f.HB, g.id, { name: "X" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      contributeToGoal(f.deps, f.B, f.HB, g.id, { direction: "add", amountMinor: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteGoal(f.deps, f.B, f.HB, g.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listGoals(f.deps, f.B, f.HB)).toEqual([]);
    expect((await getGoal(f.deps, f.C, f.HA, g.id)).name).toBe("Secret");
  });

  it("ștergere definitivă, cu audit fără sume sau nume", async () => {
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "De șters",
      targetMinor: 10,
      currency: "RON",
    });
    await deleteGoal(f.deps, f.A, f.HA, g.id);
    await expect(getGoal(f.deps, f.A, f.HA, g.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteGoal(f.deps, f.A, f.HA, g.id)).rejects.toBeInstanceOf(NotFoundError);
    const [audit] = await f.admin<{ metadata: unknown }[]>`
      select metadata from finet.audit_events where action = 'goal.deleted' and target_id = ${g.id}`;
    expect(audit!.metadata).toEqual({ status: "active" });
  });
});
