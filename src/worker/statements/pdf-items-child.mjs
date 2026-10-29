// Procesul copil care extrage ELEMENTELE DE TEXT POZIȚIONALE dintr-un extras PDF cu pdf.js
// (unpdf), pornit de `pdf-items-sandbox.ts` sub limite de sistem (`prlimit`: spațiu de adrese,
// CPU, fără scriere de fișiere) și ucis cu SIGKILL la timeout (ADR 0018, după modelul Fazei 6,
// ADR 0013). JavaScript simplu, copiat neschimbat în `dist/tools/` de scripts/build-tools.mjs.
// Nu primește mediul părintelui.
//
// Intrare: octeții PDF pe stdin; argumentele: maxPages, maxItemsPerPage, maxItems, maxItemChars.
// Ieșire pe stdout: O SINGURĂ linie JSON: `{ pages, items: [[p, x, y, w, s], ...] }` sau
// `{ error }`. Fără imagini: un extras fără text (scanat) e refuzat (`pdf_no_text`).
import { getDocumentProxy } from "unpdf";

const [maxPages, maxItemsPerPage, maxItems, maxItemChars] = process.argv.slice(2).map(Number);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const round = (n) => Math.round(n * 100) / 100;
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

function isMemoryError(error) {
  return (
    error instanceof RangeError || /allocation|out of memory|heap/i.test(String(error?.message))
  );
}

try {
  const input = await readStdin();
  let pdf;
  try {
    pdf = await getDocumentProxy(input, {
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
    });
  } catch (error) {
    write({ error: error?.name === "PasswordException" ? "pdf_encrypted" : "pdf_invalid" });
    process.exit(0);
  }
  const pages = pdf.numPages;
  if (!(pages >= 1)) {
    write({ error: "pdf_invalid" });
  } else if (pages > maxPages) {
    write({ error: "too_many_pages" });
  } else {
    const items = [];
    let failed = null;
    for (let p = 1; p <= pages && !failed; p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      let onPage = 0;
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const s = String(it.str).replace(CONTROL, "").trim();
        if (s === "") continue;
        const x = Number(it.transform?.[4]);
        const y = Number(it.transform?.[5]);
        const w = Number(it.width);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) continue;
        if (++onPage > maxItemsPerPage || items.length >= maxItems) {
          failed = "pdf_too_complex";
          break;
        }
        items.push([p, round(x), round(y), round(Math.max(0, w)), s.slice(0, maxItemChars)]);
      }
    }
    if (failed) write({ error: failed });
    else if (items.length === 0) write({ error: "pdf_no_text" });
    else write({ pages, items });
  }
} catch (error) {
  write({ error: isMemoryError(error) ? "pdf_too_complex" : "pdf_invalid" });
}
process.stdout.end();
