import { CURRENCIES, type Currency, isCurrency } from "@/lib/money";

/**
 * Cursurile BCE (ADR 0049): parserul XML-ului zilnic / pe 90 de zile
 * (`eurofxref-daily.xml`, `eurofxref-hist-90d.xml`), scris în cod (fără dependență XML): formatul
 * e fix, `<Cube time='YYYY-MM-DD'>` cu `<Cube currency='USD' rate='1.0856'/>`. Doar monedele
 * aplicației (fără EUR, care e baza). Cursul devine `rateMicro` = curs × 1.000.000, din șirul
 * zecimal, fără float. Orice valoare malformată e ignorată (fail closed per rând).
 */

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_HISTORY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
export const ECB_HOST = "www.ecb.europa.eu";
export const ECB_MAX_BYTES = 2 * 1024 * 1024;
export const ECB_TIMEOUT_MS = 15_000;

export type EcbRate = Readonly<{ date: string; currency: Currency; rateMicro: bigint }>;

const WANTED = new Set<string>(CURRENCIES.filter((c) => c !== "EUR"));

/** `1.0856` → 1.085.600; cel mult 6 zecimale; respinge orice altceva. */
export function rateToMicro(text: string): bigint | null {
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(6, "0");
  const micro = whole * 1_000_000n + BigInt(frac);
  return micro > 0n ? micro : null;
}

export function parseEcbXml(xml: string): EcbRate[] {
  const out: EcbRate[] = [];
  if (xml.length > ECB_MAX_BYTES) return out;
  const dayRe = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
  for (const day of xml.matchAll(dayRe)) {
    const date = day[1]!;
    for (const r of day[2]!.matchAll(rateRe)) {
      const currency = r[1]!;
      if (!WANTED.has(currency) || !isCurrency(currency)) continue;
      const micro = rateToMicro(r[2]!);
      if (micro === null) continue;
      out.push({ date, currency, rateMicro: micro });
    }
  }
  return out;
}

export type EcbFetch = (url: string) => Promise<string>;

/**
 * Descărcarea sigură: gazda fixă, fără redirecționări, corp plafonat, termen. Fără date trimise
 * (GET simplu). Injectabilă în teste.
 */
export async function fetchEcb(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.host !== ECB_HOST) {
    throw new Error("fx_url_not_allowed");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ECB_TIMEOUT_MS);
  try {
    const res = await fetchImpl(u, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/xml,text/xml" },
    });
    if (!res.ok) throw new Error(`fx_http_${res.status}`);
    const declared = res.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > ECB_MAX_BYTES) {
      throw new Error("fx_too_large");
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > ECB_MAX_BYTES) throw new Error("fx_too_large");
    return new TextDecoder("utf-8").decode(buf);
  } finally {
    clearTimeout(timer);
  }
}
