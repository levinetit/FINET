/**
 * Ajutoare pure pentru interfața listelor de cumpărături (Faza 10, F10-A; ADR 0022). Fără
 * importuri din `@/db` sau din module server (ajung în pachetul clientului); cantitatea rămâne
 * TEXT, niciodată număr în virgulă mobilă.
 */

const QUANTITY_RE = /^\d{1,6}(?:\.\d{1,3})?$/;

/**
 * Cantitatea scrisă de utilizator (`2`, `0,5`, `1.250`) → forma canonică trimisă API-ului
 * (`"2"`, `"0.5"`, `"1.25"`), sau `null` dacă nu e un număr pozitiv cu cel mult 3 zecimale.
 * Un câmp gol înseamnă „implicit” (`""`).
 */
export function parseQuantityInput(raw: string): string | "" | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return "";
  if (!QUANTITY_RE.test(text) || !/[1-9]/.test(text)) return null;
  const [int = "0", frac = ""] = text.split(".");
  const i = int.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f === "" ? i : `${i}.${f}`;
}

/** `"0.5"` → `"0,5"` (virgulă zecimală în română). */
export function displayQuantity(q: string): string {
  return q.replace(".", ",");
}

/** Articolul într-un rând: `2 × lapte`, `0,5 kg brânză`; cantitatea `1` fără unitate nu se arată. */
export function quantityLabel(quantity: string, unit: string | null): string {
  if (quantity === "1" && !unit) return "";
  return unit ? `${displayQuantity(quantity)} ${unit}` : `${displayQuantity(quantity)} ×`;
}

/** Mută elementul `id` cu o poziție în sus (`-1`) sau în jos (`1`); lista nu se modifică pe loc. */
export function moveId(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
