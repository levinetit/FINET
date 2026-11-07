import { afterEach, describe, expect, it } from "vitest";

import { type LogRecord, errorCodeOf, log, setLogSink } from "./log";

/** Jurnalizarea structurată (ADR 0052): o linie pe eveniment, câmpuri filtrate, fără conținut. */

describe("log", () => {
  const records: LogRecord[] = [];
  let restore = () => {};
  afterEach(() => restore());

  it("emite JSON cu time/level/scope/event și câmpurile permise", () => {
    restore = setLogSink((r) => void records.push(r));
    log.error("api", "unexpected", {
      code: "23505",
      count: 3,
      ok: false,
      skip: undefined,
      nul: null,
    });
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.level).toBe("error");
    expect(r.scope).toBe("api");
    expect(r.event).toBe("unexpected");
    expect(r.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r).toMatchObject({ code: "23505", count: 3, ok: false, nul: null });
    expect("skip" in r).toBe(false);
  });

  it("taie șirurile lungi, ignoră cheile rezervate sau invalide, normalizează scope/event", () => {
    const out: LogRecord[] = [];
    restore = setLogSink((r) => void out.push(r));
    log.warn("Scop Invalid!", "Eveniment cu spații", {
      long: "x".repeat(500),
      time: "fals",
      level: "fals",
      "chei e": "nu",
      nan: Number.NaN,
    });
    const r = out[0]!;
    expect(r.scope).toBe("app");
    expect(r.event).toBe("event");
    expect((r.long as string).length).toBe(201);
    expect(r.time).not.toBe("fals");
    expect(r.level).toBe("warn");
    expect("chei e" in r).toBe(false);
    expect(r.nan).toBeNull();
  });

  it("errorCodeOf: codul driverului (și din cause), altfel numele erorii, altfel unknown", () => {
    expect(errorCodeOf({ code: "23505" })).toBe("23505");
    expect(errorCodeOf(new Error("x", { cause: { code: "ECONNREFUSED" } }))).toBe("ECONNREFUSED");
    expect(errorCodeOf(new RangeError("y"))).toBe("RangeError");
    expect(errorCodeOf("text")).toBe("unknown");
    expect(errorCodeOf({ code: "cu spații și valori secrete" })).toBe("unknown");
  });
});
