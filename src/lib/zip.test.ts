import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { type ZipEntryOptions, type ZipSource, assertEntryName, zipStream } from "./zip";

async function build(
  entries: (readonly [string, ZipSource, ZipEntryOptions?])[],
): Promise<Buffer> {
  async function* gen() {
    for (const e of entries) yield e;
  }
  const parts: Uint8Array[] = [];
  for await (const p of zipStream(gen(), new Date("2026-10-29T10:00:00Z"))) parts.push(p);
  return Buffer.concat(parts);
}

function hasTool(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const bigText = "linie de test cu diacritice ăâîșț, 0,00 lei\n".repeat(20_000);
const binary = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7919) % 256);

async function* slowChunks(): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < binary.length; i += 4096) yield binary.subarray(i, i + 4096);
}

describe("zipStream (fără bibliotecă)", () => {
  it("structura: intrările deflate/store se pot reciti cu inflate; directorul central e corect", async () => {
    const zip = await build([
      ["a.json", '{"x":1}'],
      ["gospodării/ț.txt", bigText],
      ["fisiere/poza.jpg", slowChunks(), { method: "store" }],
    ]);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(3);
    // Prima intrare: antet local + nume + date deflate.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe("a.json");
    // Textul mare e comprimat (mult sub dimensiunea lui).
    expect(zip.length).toBeLessThan(bigText.length / 4 + binary.length + 4096);
    const cdStart = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt32LE(cdStart)).toBe(0x02014b50);
    const comp = zip.readUInt32LE(cdStart + 20);
    const raw = inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + comp));
    expect(raw.toString()).toBe('{"x":1}');
  });

  it.skipIf(!hasTool("python3", ["--version"]))(
    "verificare independentă: Python zipfile (testzip + conținut) și unzip -t",
    async () => {
      const zip = await build([
        ["README.txt", "Exportul tău FINET"],
        ["gospodării/1/tranzacții.csv", bigText],
        ["gospodării/1/fisiere/bon.png", binary, { method: "store" }],
        ["gol.json", ""],
      ]);
      const dir = mkdtempSync(join(tmpdir(), "finet-zip-"));
      try {
        const file = join(dir, "export.zip");
        writeFileSync(file, zip);
        const script = [
          "import sys, zipfile, hashlib",
          "z = zipfile.ZipFile(sys.argv[1])",
          "assert z.testzip() is None",
          "print(';'.join(i.filename + ':' + str(i.file_size) + ':' + hashlib.sha256(z.read(i)).hexdigest()[:16] for i in z.infolist()))",
        ].join("\n");
        const out = execFileSync("python3", ["-I", "-c", script, file]).toString().trim();
        const sha = (b: Uint8Array | string) =>
          createHash("sha256").update(b).digest("hex").slice(0, 16);
        expect(out).toBe(
          [
            `README.txt:${Buffer.byteLength("Exportul tău FINET")}:${sha("Exportul tău FINET")}`,
            `gospodării/1/tranzacții.csv:${Buffer.byteLength(bigText)}:${sha(bigText)}`,
            `gospodării/1/fisiere/bon.png:${binary.length}:${sha(binary)}`,
            `gol.json:0:${sha("")}`,
          ].join(";"),
        );
        if (hasTool("unzip", ["-v"])) {
          const t = execFileSync("unzip", ["-t", file]).toString();
          expect(t).toContain("No errors detected");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("numele cu `..`, absolute, cu `\\` sau caractere de control sunt refuzate", async () => {
    for (const bad of ["../x", "/abs", "a\\b", "a//b", "a/./b", "x\u0000", ""]) {
      expect(() => assertEntryName(bad)).toThrow();
    }
    await expect(build([["../evadare.txt", "x"]])).rejects.toThrow();
    expect(() => assertEntryName("gospodării/ok/fișier.json")).not.toThrow();
  });
});
