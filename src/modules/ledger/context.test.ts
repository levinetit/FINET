import { describe, expect, it } from "vitest";

import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";

import { translateDbError } from "./context";

/** Traducerea erorilor Postgres în erori de domeniu cu cod fix, fără mesajul original. */
describe("translateDbError", () => {
  const pg = (code: string, message = "valoare secretă 45,90 lei") =>
    Object.assign(new Error(message), { code, name: "PostgresError" });
  const wrapped = (inner: Error) =>
    Object.assign(new Error("Failed query: insert … params: LIDL,4590"), { cause: inner });

  const caught = (error: unknown): unknown => {
    try {
      translateDbError(error);
    } catch (e) {
      return e;
    }
    throw new Error("nu a aruncat");
  };

  it("22021 (NUL / caracter invalid) → 400 cu mesaj fix, și împachetată de Drizzle", () => {
    for (const error of [pg("22021"), wrapped(pg("22021"))]) {
      const e = caught(error);
      expect(e).toBeInstanceOf(ValidationError);
      const v = e as ValidationError;
      expect(v.code).toBe("invalid_request");
      expect(v.fields).toEqual({ _: "Textul conține caractere nepermise." });
      expect(JSON.stringify({ m: v.message, f: v.fields })).not.toMatch(/45,90|LIDL|4590|secret/);
    }
  });

  it("restul codurilor rămân ca înainte", () => {
    expect(caught(pg("23514"))).toBeInstanceOf(ConflictError);
    expect(caught(pg("42501"))).toBeInstanceOf(NotFoundError);
    const other = pg("57014");
    expect(caught(other)).toBe(other);
  });
});
