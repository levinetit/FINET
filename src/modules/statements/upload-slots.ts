/**
 * Plafonul încărcărilor de extrase SIMULTANE într-un proces web (revizuirea F7-B, M1). Bugetul de
 * memorie: un fișier ≤ 20 MB ținut o dată în memorie (bucățile se unesc o singură dată și se
 * eliberează), plus, pentru un ZIP, intrările decomprimate (≤ 50 MB în total, `STATEMENT_ZIP_LIMITS`)
 * și tabelele citite din ele: ~70–100 MB în cel mai rău caz pe cerere. Cu 2 cereri simultane,
 * ≤ ~200 MB, sub `mem_limit` 512 MB al `finet-web`. Peste plafon: 503 `statement_upload_busy` cu
 * `Retry-After` (clientul reîncearcă), fără a citi corpul.
 */

export const STATEMENT_UPLOAD_CONCURRENCY = 2;
export const STATEMENT_UPLOAD_RETRY_AFTER_SECONDS = 5;

let active = 0;

/** Un loc liber → funcția care îl eliberează (o singură dată); altfel `null`. */
export function tryAcquireUploadSlot(
  max: number = STATEMENT_UPLOAD_CONCURRENCY,
): (() => void) | null {
  if (active >= max) return null;
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
  };
}

/** Doar pentru teste și diagnoză: câte încărcări rulează acum. */
export function activeUploads(): number {
  return active;
}
