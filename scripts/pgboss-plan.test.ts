import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MIGRATION_PATH,
  buildPgBossMigration,
  installedSchemaVersion,
  splitSql,
} from "./pgboss-plan.mjs";

describe("migrația 0007_pgboss și pg-boss instalat", () => {
  it("fișierul din repo e exact cel generat din versiunea instalată a pg-boss", () => {
    // Dacă pică după actualizarea pg-boss: NU regenera 0007 (e aplicată pe producție); scrie o
    // migrație nouă din getMigrationPlans (ADR 0011).
    expect(readFileSync(MIGRATION_PATH, "utf8")).toBe(buildPgBossMigration());
  });

  it("versiunea schemei din migrație = versiunea așteptată de pachet", () => {
    const text = readFileSync(MIGRATION_PATH, "utf8");
    const m = /INSERT INTO pgboss\.version\(version\) VALUES \('(\d+)'\)/.exec(text);
    expect(Number(m?.[1])).toBe(installedSchemaVersion());
  });

  it("splitSql nu taie corpurile dollar-quoted, șirurile sau comentariile", () => {
    expect(
      splitSql(`select 'a;b'; -- x;y
create function f() returns int as $$ begin return 1; end $$ language plpgsql;
select $cmd$ alter table t; $cmd$;`),
    ).toEqual([
      "select 'a;b'",
      "-- x;y\ncreate function f() returns int as $$ begin return 1; end $$ language plpgsql",
      "select $cmd$ alter table t; $cmd$",
    ]);
  });
});
