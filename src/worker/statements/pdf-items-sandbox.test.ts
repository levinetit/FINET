import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildStatementFixtures } from "../../../scripts/make-statement-fixtures.mjs";

import { textPdf } from "@/modules/documents/testing";
import { checkBalances } from "@/modules/statements/balances";
import { parsePdfItems } from "@/modules/statements/detect";
import { itemsToPdf } from "@/modules/statements/testing";

import {
  StatementPdfError,
  activeStatementPdfChildren,
  extractStatementPdfItems,
} from "./pdf-items-sandbox";

/**
 * Stratul de extracție (PDF → elemente poziționale) în procesul copil limitat, pe PDF-uri
 * SINTETICE generate în test din fixture-uri, plus cazurile ostile: PDF invalid, prea multe
 * pagini, fără text, termen depășit, copil care minte.
 */

const deadline = () => Date.now() + 30_000;
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
    return "acceptat";
  } catch (e) {
    expect(e).toBeInstanceOf(StatementPdfError);
    return (e as StatementPdfError).code;
  }
};

describe("extracția elementelor dintr-un extras PDF (proces copil)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "finet-stmt-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["bt", "brd", "raiffeisen", "revolut"] as const)(
    "%s: PDF sintetic → elemente → parser: aceleași rânduri și solduri ca fixture-ul",
    async (bank) => {
      const f = buildStatementFixtures()[bank];
      const items = await extractStatementPdfItems(itemsToPdf(f.items), { deadline: deadline() });
      // pdf.js poate uni fragmente vecine de pe același rând (ca în extrasele reale).
      expect(items.length).toBeGreaterThan(f.items.length * 0.8);
      expect(items.length).toBeLessThanOrEqual(f.items.length);
      expect(items.every((i) => i.w >= 0 && Number.isFinite(i.x) && Number.isFinite(i.y))).toBe(
        true,
      );
      const s = parsePdfItems(items);
      expect(s.bank).toBe(bank);
      expect(s.lines).toHaveLength(f.expected.lines.length);
      expect(s.closingBalanceMinor).toBe(BigInt(f.expected.closingBalanceMinor));
      expect(checkBalances(s).status).toBe("ok");
      expect(activeStatementPdfChildren()).toBe(0);
    },
    60_000,
  );

  it("PDF invalid, fără text, prea multe pagini → coduri fixe", async () => {
    expect(
      await fail(extractStatementPdfItems(Buffer.from("nu e pdf"), { deadline: deadline() })),
    ).toBe("pdf_invalid");
    expect(await fail(extractStatementPdfItems(textPdf([" "]), { deadline: deadline() }))).toBe(
      "pdf_no_text",
    );
    const many = itemsToPdf([{ p: 1, x: 10, y: 10, w: 10, s: "x" }], 61);
    expect(await fail(extractStatementPdfItems(many, { deadline: deadline() }))).toBe(
      "too_many_pages",
    );
    expect(await fail(extractStatementPdfItems(many, { deadline: deadline(), maxPages: 5 }))).toBe(
      "too_many_pages",
    );
    expect(activeStatementPdfChildren()).toBe(0);
  }, 60_000);

  it("termen depășit → SIGKILL și `extract_timeout`, fără copil rămas", async () => {
    const slow = join(dir, "slow.mjs");
    await writeFile(slow, "setInterval(() => {}, 1000);\n");
    const started = Date.now();
    expect(
      await fail(
        extractStatementPdfItems(textPdf(), { deadline: Date.now() + 500, childScript: slow }),
      ),
    ).toBe("extract_timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(activeStatementPdfChildren()).toBe(0);
  });

  it("un copil care minte (elemente invalide, ieșire uriașă, eroare necunoscută) e refuzat", async () => {
    const cases: [string, string][] = [
      ["bad.mjs", `process.stdout.write(JSON.stringify({pages:1,items:[[1,"x",2,3,"s"]]})+"\\n")`],
      ["page.mjs", `process.stdout.write(JSON.stringify({pages:1,items:[[0,1,2,3,"s"]]})+"\\n")`],
      ["big.mjs", `const s="a".repeat(1<<20);for(let i=0;i<20;i++)process.stdout.write(s);`],
      ["err.mjs", `process.stdout.write(JSON.stringify({error:"altceva"})+"\\n")`],
      ["two.mjs", `process.stdout.write("{}\\n{}\\n")`],
    ];
    const codes: string[] = [];
    for (const [name, body] of cases) {
      const script = join(dir, name);
      await writeFile(script, body);
      codes.push(
        await fail(
          extractStatementPdfItems(textPdf(), { deadline: deadline(), childScript: script }),
        ),
      );
    }
    expect(codes).toEqual([
      "pdf_too_complex",
      "pdf_too_complex",
      "pdf_too_complex",
      "pdf_invalid",
      "pdf_invalid",
    ]);
    expect(activeStatementPdfChildren()).toBe(0);
  });

  it("copil lipsă → `pdf_sandbox_unavailable` (fail-closed); fișier peste plafon → refuz", async () => {
    expect(
      await fail(
        extractStatementPdfItems(textPdf(), {
          deadline: deadline(),
          childScript: join(dir, "nu-exista.mjs"),
        }),
      ),
    ).toBe("pdf_sandbox_unavailable");
    expect(
      await fail(
        extractStatementPdfItems(Buffer.alloc(21 * 1024 * 1024), { deadline: deadline() }),
      ),
    ).toBe("pdf_too_complex");
  });
});
