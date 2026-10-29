import { describe, expect, it } from "vitest";

import {
  SplitMathError,
  computeBalances,
  isSettled,
  splitByBasisPoints,
  splitEqually,
  splitFixed,
} from "./split-math";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const sum = (shares: { shareMinor: bigint }[]) => shares.reduce((a, s) => a + s.shareMinor, 0n);

describe("împărțirea egală", () => {
  it("restul merge primilor în ordinea userId, indiferent de ordinea din cerere", () => {
    expect(splitEqually(100n, "RON", [C, A, B])).toEqual([
      { userId: A, shareMinor: 34n },
      { userId: B, shareMinor: 33n },
      { userId: C, shareMinor: 33n },
    ]);
    expect(splitEqually(101n, "RON", [B, A])).toEqual([
      { userId: A, shareMinor: 51n },
      { userId: B, shareMinor: 50n },
    ]);
  });

  it("suma părților = totalul pentru orice total și 1–6 participanți", () => {
    const users = [
      A,
      B,
      C,
      "00000000-0000-4000-8000-00000000000d",
      "00000000-0000-4000-8000-00000000000e",
      "00000000-0000-4000-8000-00000000000f",
    ];
    for (const total of [
      0n,
      1n,
      2n,
      5n,
      99n,
      100n,
      101n,
      9_999_999_999_999n,
      10_000_000_000_000n,
    ]) {
      for (let n = 1; n <= 6; n++) {
        const parts = splitEqually(total, "RON", users.slice(0, n));
        expect(sum(parts)).toBe(total);
        const values = parts.map((p) => p.shareMinor);
        const max = values.reduce((a, b) => (b > a ? b : a));
        const min = values.reduce((a, b) => (b < a ? b : a));
        expect(max - min <= 1n).toBe(true);
      }
    }
  });

  it("refuză participanți duplicați sau lista goală", () => {
    expect(() => splitEqually(10n, "RON", [A, A])).toThrow(SplitMathError);
    expect(() => splitEqually(10n, "RON", [])).toThrow(SplitMathError);
  });
});

describe("împărțirea pe procente (puncte de bază)", () => {
  it("cazul clasic 1/3: 33,34% / 33,33% / 33,33% din 100,00 lei", () => {
    const parts = splitByBasisPoints(10_000n, "RON", [
      { userId: B, value: 3333n },
      { userId: A, value: 3334n },
      { userId: C, value: 3333n },
    ]);
    expect(parts).toEqual([
      { userId: A, shareMinor: 3334n },
      { userId: B, shareMinor: 3333n },
      { userId: C, shareMinor: 3333n },
    ]);
  });

  it("restul cel mai mare primește unitatea; la egalitate primul userId", () => {
    // 1 ban la 50/50: resturi egale → A (primul userId).
    expect(
      splitByBasisPoints(1n, "RON", [
        { userId: B, value: 5000n },
        { userId: A, value: 5000n },
      ]),
    ).toEqual([
      { userId: A, shareMinor: 1n },
      { userId: B, shareMinor: 0n },
    ]);
    // 10 bani la 70/30 → 7 / 3 exact; 11 bani → 7,7 / 3,3 → 8 / 3.
    expect(
      splitByBasisPoints(11n, "RON", [
        { userId: A, value: 7000n },
        { userId: B, value: 3000n },
      ]).map((s) => s.shareMinor),
    ).toEqual([8n, 3n]);
  });

  it("suma părților = totalul pentru combinații de procente", () => {
    const combos = [
      [5000n, 5000n],
      [3334n, 3333n, 3333n],
      [1n, 9999n],
      [0n, 10_000n],
      [2500n, 2500n, 2500n, 2500n],
      [1667n, 1667n, 1667n, 1667n, 1666n, 1666n],
    ];
    for (const total of [0n, 1n, 7n, 100n, 12_345n, 10_000_000_000_000n]) {
      for (const bp of combos) {
        const users = [
          A,
          B,
          C,
          "00000000-0000-4000-8000-00000000000d",
          "00000000-0000-4000-8000-00000000000e",
          "00000000-0000-4000-8000-00000000000f",
        ];
        const parts = splitByBasisPoints(
          total,
          "RON",
          bp.map((value, i) => ({ userId: users[i]!, value })),
        );
        expect(sum(parts)).toBe(total);
      }
    }
  });

  it("refuză procentele care nu însumează exact 100%", () => {
    expect(() =>
      splitByBasisPoints(100n, "RON", [
        { userId: A, value: 5000n },
        { userId: B, value: 4999n },
      ]),
    ).toThrow(expect.objectContaining({ reason: "percent_total" }));
    expect(() =>
      splitByBasisPoints(100n, "RON", [
        { userId: A, value: 6000n },
        { userId: B, value: 5000n },
      ]),
    ).toThrow(expect.objectContaining({ reason: "percent_total" }));
  });
});

describe("sume fixe", () => {
  it("acceptă doar suma exactă a totalului", () => {
    expect(
      splitFixed(1000n, [
        { userId: B, value: 400n },
        { userId: A, value: 600n },
      ]),
    ).toEqual([
      { userId: A, shareMinor: 600n },
      { userId: B, shareMinor: 400n },
    ]);
    expect(() =>
      splitFixed(1000n, [
        { userId: A, value: 600n },
        { userId: B, value: 399n },
      ]),
    ).toThrow(expect.objectContaining({ reason: "fixed_total" }));
    expect(() =>
      splitFixed(1000n, [
        { userId: A, value: 1001n },
        { userId: B, value: -1n },
      ]),
    ).toThrow(expect.objectContaining({ reason: "negative" }));
  });
});

describe("solduri reciproce", () => {
  it("2 membri: A plătește 100, împărțit egal → B îi datorează 50; decontare parțială, apoi 0", () => {
    const splits = [
      { payerUserId: A, userId: A, shareMinor: 50n, currency: "RON" as const },
      { payerUserId: A, userId: B, shareMinor: 50n, currency: "RON" as const },
    ];
    let b = computeBalances(splits, []);
    expect(b).toEqual([
      {
        currency: "RON",
        pairs: [{ debtorUserId: B, creditorUserId: A, amountMinor: 50n }],
        members: [
          { userId: A, netMinor: 50n },
          { userId: B, netMinor: -50n },
        ],
      },
    ]);
    const partial = [{ fromUserId: B, toUserId: A, amountMinor: 20n, currency: "RON" as const }];
    b = computeBalances(splits, partial);
    expect(b[0]!.pairs).toEqual([{ debtorUserId: B, creditorUserId: A, amountMinor: 30n }]);
    expect(isSettled(b, B)).toBe(false);
    b = computeBalances(splits, [
      ...partial,
      { fromUserId: B, toUserId: A, amountMinor: 30n, currency: "RON" },
    ]);
    expect(b[0]!.pairs).toEqual([]);
    expect(b[0]!.members.every((m) => m.netMinor === 0n)).toBe(true);
    expect(isSettled(b, A) && isSettled(b, B)).toBe(true);
  });

  it("3 membri: netting pe perechi, total pe membru, suma totalurilor = 0, monede separate", () => {
    const r = (payer: string, user: string, share: bigint, currency: "RON" | "EUR" = "RON") => ({
      payerUserId: payer,
      userId: user,
      shareMinor: share,
      currency,
    });
    const splits = [
      // A plătește 90 pentru toți trei (30 fiecare).
      r(A, A, 30n),
      r(A, B, 30n),
      r(A, C, 30n),
      // B plătește 60 pentru B și C (30 fiecare).
      r(B, B, 30n),
      r(B, C, 30n),
      // C plătește 20 pentru A și C.
      r(C, A, 10n),
      r(C, C, 10n),
      // În euro, separat: B plătește 10 € pentru A.
      r(B, A, 1000n, "EUR"),
    ];
    const b = computeBalances(splits, []);
    expect(b.map((c) => c.currency)).toEqual(["EUR", "RON"]);
    const ron = b.find((c) => c.currency === "RON")!;
    // A↔B: B îi datorează 30; A↔C: C îi datorează 30, A îi datorează 10 → C îi datorează 20;
    // B↔C: C îi datorează 30.
    expect(ron.pairs).toEqual([
      { debtorUserId: B, creditorUserId: A, amountMinor: 30n },
      { debtorUserId: C, creditorUserId: A, amountMinor: 20n },
      { debtorUserId: C, creditorUserId: B, amountMinor: 30n },
    ]);
    expect(ron.members).toEqual([
      { userId: A, netMinor: 50n },
      { userId: B, netMinor: 0n },
      { userId: C, netMinor: -50n },
    ]);
    expect(ron.members.reduce((a, m) => a + m.netMinor, 0n)).toBe(0n);
    const eur = b.find((c) => c.currency === "EUR")!;
    expect(eur.pairs).toEqual([{ debtorUserId: A, creditorUserId: B, amountMinor: 1000n }]);
    // B are net 0 în RON dar perechi nenule: nu e „decontat”.
    expect(isSettled(b, B)).toBe(false);
  });

  it("o decontare peste datorie inversează sensul (nu se pierde nimic)", () => {
    const b = computeBalances(
      [{ payerUserId: A, userId: B, shareMinor: 10n, currency: "RON" }],
      [{ fromUserId: B, toUserId: A, amountMinor: 15n, currency: "RON" }],
    );
    expect(b[0]!.pairs).toEqual([{ debtorUserId: A, creditorUserId: B, amountMinor: 5n }]);
  });
});
