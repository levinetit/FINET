import { describe, expect, it } from "vitest";

import { multipartRequest } from "@/modules/documents/testing";

import { StatementUploadError, readStatementMultipart } from "./multipart";

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "acceptat";
  } catch (e) {
    expect(e).toBeInstanceOf(StatementUploadError);
    return (e as StatementUploadError).reason;
  }
};

/** Limitele corpului la încărcarea extraselor, la valoarea EXACTĂ și +1 (revizuirea F7-B, m1). */
describe("corpul încărcării unui extras", () => {
  it("fișierul de exact `maxFileBytes` e acceptat; cu un octet în plus → `file_too_large`", async () => {
    const ok = await readStatementMultipart(
      await multipartRequest([["file", Buffer.alloc(10, 0x41), "x"]]),
      10,
    );
    expect(ok.bytes.length).toBe(10);
    expect(
      await reason(
        readStatementMultipart(await multipartRequest([["file", Buffer.alloc(11, 0x41), "x"]]), 10),
      ),
    ).toBe("file_too_large");
  });

  it("`mapping` de exact 4096 caractere e acceptat; 4097 → `invalid_field`", async () => {
    const at = await readStatementMultipart(
      await multipartRequest([
        ["mapping", "a".repeat(4096)],
        ["file", Buffer.from("x"), "x"],
      ]),
    );
    expect(at.fields.mapping).toHaveLength(4096);
    expect(
      await reason(
        readStatementMultipart(
          await multipartRequest([
            ["mapping", "a".repeat(4097)],
            ["file", Buffer.from("x"), "x"],
          ]),
        ),
      ),
    ).toBe("invalid_field");
  });

  it("câmpuri necunoscute, două fișiere, fără fișier, fișier gol: refuzate cu motiv stabil", async () => {
    const f = Buffer.from("abc");
    expect(
      await reason(
        readStatementMultipart(
          await multipartRequest([
            ["kind", "x"],
            ["file", f, "x"],
          ]),
        ),
      ),
    ).toBe("invalid_field");
    expect(
      await reason(
        readStatementMultipart(
          await multipartRequest([
            ["file", f, "a"],
            ["file", f, "b"],
          ]),
        ),
      ),
    ).toMatch(/too_many_files|invalid_field/);
    expect(await reason(readStatementMultipart(await multipartRequest([["accountId", "x"]])))).toBe(
      "no_files",
    );
    expect(
      await reason(
        readStatementMultipart(await multipartRequest([["file", Buffer.alloc(0), "x"]])),
      ),
    ).toBe("empty_file");
  });
});
