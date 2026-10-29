// Procesul copil care citește un PDF cu pdf.js (unpdf), pornit de `pdf-sandbox.ts` sub limite de
// sistem (`prlimit`: spațiu de adrese, CPU, fără scriere de fișiere) și ucis cu SIGKILL la
// timeout (ADR 0013; revizuirea de securitate F6-A). JavaScript simplu (nu TypeScript), copiat
// neschimbat în `dist/tools/` de scripts/build-tools.mjs, ca să ruleze la fel în teste și în
// imaginea `tools`. Nu primește mediul părintelui (fără URL-uri sau căi de secrete).
//
// Intrare: octeții PDF pe stdin; argumentele: maxPages, minTextChars, maxImagesPerPage.
// Ieșire pe stdout: o linie JSON (`{pages,text,images:[{width,height,channels,length}]}` sau
// `{error}`), urmată de pixelii bruți ai imaginilor, în ordine. Părintele plafonează ieșirea.
import { extractImages, extractText, getDocumentProxy } from "unpdf";

const [maxPages, minTextChars, maxImagesPerPage] = process.argv.slice(2).map(Number);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

function write(header, buffers = []) {
  process.stdout.write(JSON.stringify(header) + "\n");
  for (const b of buffers) process.stdout.write(b);
}

function isMemoryError(error) {
  return (
    error instanceof RangeError || /allocation|out of memory|heap/i.test(String(error?.message))
  );
}

let pdf;
try {
  const input = await readStdin();
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
    const text = (await extractText(pdf, { mergePages: false })).text.map((t) => t.trim());
    const significant = text.join("").replace(/[^\p{L}\p{N}]/gu, "").length;
    if (significant >= minTextChars) {
      write({ pages, text, images: null });
    } else {
      const images = [];
      const data = [];
      let tooMany = false;
      for (let page = 1; page <= pages && !tooMany; page++) {
        const found = await extractImages(pdf, page);
        if (found.length > maxImagesPerPage) {
          tooMany = true;
          break;
        }
        found.sort((a, b) => b.width * b.height - a.width * a.height);
        const largest = found[0];
        if (!largest) continue;
        images.push({
          width: largest.width,
          height: largest.height,
          channels: largest.channels,
          length: largest.data.byteLength,
        });
        data.push(
          Buffer.from(largest.data.buffer, largest.data.byteOffset, largest.data.byteLength),
        );
      }
      if (tooMany) write({ error: "pdf_too_complex" });
      else write({ pages, text, images }, data);
    }
  }
} catch (error) {
  write({ error: isMemoryError(error) ? "pdf_too_complex" : "pdf_invalid" });
}
process.stdout.end();
