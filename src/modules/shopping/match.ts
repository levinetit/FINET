/**
 * Potrivirea listă de cumpărături ↔ bon (master prompt 3.6; ADR 0022), ÎN COD. Funcții pure,
 * deterministe, fără bază de date și fără rețea: nume normalizate (`normalizeProductName`),
 * potrivire pe cuvinte (cu rădăcină comună și similaritate de trigrame pentru variante de
 * scriere), scor 0–100, alocare 1–la–1 greedy după scor. Un LLM nu decide nimic aici: pasul
 * opțional cu LLM (worker) primește doar perechile AMBIGUE produse de `planMatches` și poate
 * doar să aleagă una dintre liniile candidate sau „niciuna".
 *
 * Scorul unei perechi (articol A, linie de bon B), pe cuvintele „de conținut" (fără numere,
 * unități și cuvinte de legătură):
 *   c = media, pe cuvintele lui A, a celei mai bune similarități cu un cuvânt din B;
 *   p = media, pe cuvintele lui B, a celei mai bune similarități cu un cuvânt din A;
 *   scor = 0,75·c + 0,25·p
 *          + 0,10 dacă primul cuvânt al lui A este primul cuvânt al lui B (substantivul-cap vine
 *            primul în română: „lapte zuzu", dar „ciocolată cu lapte"), − 0,10 dacă cel mai bun
 *            cuvânt pentru primul cuvânt al lui A nu e primul din B;
 *          + 0,05 dacă au măcar o mărime/cantitate în comun („1l"), − 0,15 dacă ambele au
 *            mărimi și niciuna nu coincide („1l" față de „2l": probabil același produs, în alt
 *            ambalaj, deci rămâne propunere, nu respingere).
 * Praguri: scor ≥ `MATCH_HIGH` = propunere sigură; între `MATCH_LOW` și `MATCH_HIGH` = AMBIGUĂ
 * (utilizatorul o vede marcată „nesigur", iar pasul opțional cu LLM poate alege între
 * candidați); sub `MATCH_LOW` = fără propunere.
 */

/** Scorul de la care o pereche e propunere sigură (0–100). */
export const MATCH_HIGH = 80;
/** Scorul de la care o pereche e luată în calcul (ambiguă între `MATCH_LOW` și `MATCH_HIGH`). */
export const MATCH_LOW = 50;
/** Candidații trimiși pasului opțional cu LLM, per articol ambiguu. */
export const MAX_AMBIGUOUS_CANDIDATES = 3;

/** Cuvinte de legătură ignorate la potrivire (după normalizare: fără diacritice). */
const STOPWORDS: ReadonlySet<string> = new Set([
  "de",
  "cu",
  "la",
  "si",
  "din",
  "pe",
  "in",
  "sau",
  "fara",
  "pentru",
  "un",
  "o",
]);

export type NameTokens = Readonly<{ words: readonly string[]; sizes: readonly string[] }>;

/**
 * Cuvintele de conținut și mărimile unui nume DEJA normalizat (`normalizeProductName`). Un token
 * cu cifre e o mărime/cantitate (`1l`, `500g`, `1.5%`); restul sunt cuvinte (cele de o literă și
 * cuvintele de legătură se ignoră). Duplicatele se păstrează o singură dată, în ordine.
 */
export function tokenize(normalized: string): NameTokens {
  const words: string[] = [];
  const sizes: string[] = [];
  for (const raw of normalized.split(" ")) {
    const t = raw.trim();
    if (t === "") continue;
    if (/\d/.test(t)) {
      if (!sizes.includes(t)) sizes.push(t);
    } else if (t.length >= 2 && !STOPWORDS.has(t)) {
      if (!words.includes(t)) words.push(t);
    }
  }
  return { words, sizes };
}

/** Trigramele unui cuvânt, cu margini (`  ab `), pentru coeficientul Dice. */
function trigrams(word: string): Map<string, number> {
  const padded = `  ${word} `;
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Coeficientul Dice pe trigrame (0–1) între două cuvinte. */
export function trigramDice(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  let total = 0;
  for (const n of ta.values()) total += n;
  for (const n of tb.values()) total += n;
  for (const [g, n] of ta) shared += Math.min(n, tb.get(g) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * Similaritatea a două cuvinte (0–1): identice = 1; rădăcină comună de cel puțin 4 litere care
 * acoperă tot cuvântul mai scurt, mai puțin cel mult 2 litere (singular/plural, „banane" ↔
 * „banana") = 0,9; altfel Dice pe trigrame (cuvinte de cel puțin 5 litere) ≥ 0,6, atenuat cu 0,9.
 */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  if (min < 4) return 0;
  let common = 0;
  while (common < min && a[common] === b[common]) common++;
  if (common >= 4 && common >= min - 2) return 0.9;
  if (min >= 5) {
    const d = trigramDice(a, b);
    if (d >= 0.6) return d * 0.9;
  }
  return 0;
}

/** Scorul unei perechi de nume normalizate, întreg 0–100 (0 = fără cuvinte comparabile). */
export function scorePair(itemNormalized: string, lineNormalized: string): number {
  const a = tokenize(itemNormalized);
  const b = tokenize(lineNormalized);
  if (a.words.length === 0 || b.words.length === 0) return 0;
  let cSum = 0;
  let headBest = -1;
  let headSim = 0;
  a.words.forEach((aw, ai) => {
    let best = 0;
    b.words.forEach((bw, bi) => {
      const s = wordSimilarity(aw, bw);
      if (s > best) {
        best = s;
        if (ai === 0) {
          headBest = bi;
          headSim = s;
        }
      }
    });
    cSum += best;
  });
  let pSum = 0;
  for (const bw of b.words) {
    let best = 0;
    for (const aw of a.words) best = Math.max(best, wordSimilarity(aw, bw));
    pSum += best;
  }
  let score = 0.75 * (cSum / a.words.length) + 0.25 * (pSum / b.words.length);
  if (headBest === 0 && headSim >= 0.9) score += 0.1;
  else if (headBest > 0) score -= 0.1;
  if (a.sizes.length > 0 && b.sizes.length > 0) {
    score += a.sizes.some((s) => b.sizes.includes(s)) ? 0.05 : -0.15;
  }
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

export type MatchItem = Readonly<{
  id: string;
  /** Numele normalizat al articolului. */
  normalizedName: string;
  /** Ordinea din listă (rezolvă egalitățile deterministic). */
  position: number;
}>;

export type MatchLine = Readonly<{
  id: string;
  /** Numele normalizat al liniei de bon. */
  normalizedName: string;
  position: number;
}>;

/** Cheia unei perechi de nume normalizate, pentru istoricul confirmărilor/respingerilor. */
export function pairKey(itemNormalized: string, lineNormalized: string): string {
  return `${itemNormalized}\u0000${lineNormalized}`;
}

export type PairHistory = Readonly<{
  /** Perechi (nume articol, nume linie) pe care gospodăria le-a confirmat înainte → scor 100. */
  confirmed: ReadonlySet<string>;
  /** Perechi respinse înainte → nu se mai propun. */
  rejected: ReadonlySet<string>;
}>;

export const EMPTY_HISTORY: PairHistory = { confirmed: new Set(), rejected: new Set() };

export type PlannedPair = Readonly<{
  itemId: string;
  lineId: string;
  score: number;
  source: "code" | "learned";
  /** `true` dacă scorul e între `MATCH_LOW` și `MATCH_HIGH` (pasul opțional cu LLM). */
  ambiguous: boolean;
}>;

export type AmbiguousItem = Readonly<{
  itemId: string;
  /** Linii candidate (inclusiv cea propusă de cod), cele mai bune întâi, cel mult 3. */
  candidateLineIds: readonly string[];
}>;

export type MatchPlan = Readonly<{
  pairs: readonly PlannedPair[];
  unmatchedItemIds: readonly string[];
  unmatchedLineIds: readonly string[];
  ambiguous: readonly AmbiguousItem[];
}>;

type Scored = { item: MatchItem; line: MatchLine; score: number; source: "code" | "learned" };

/**
 * Alocarea 1–la–1: toate perechile cu scor ≥ `MATCH_LOW` (cele din istoric „confirmat" primesc 100,
 * cele „respinse" dispar), sortate după scor descrescător, apoi poziția articolului, apoi poziția
 * liniei, apoi id-uri (deterministă); fiecare articol și fiecare linie se folosesc cel mult o dată.
 */
export function planMatches(input: {
  items: readonly MatchItem[];
  lines: readonly MatchLine[];
  history?: PairHistory;
}): MatchPlan {
  const history = input.history ?? EMPTY_HISTORY;
  const all: Scored[] = [];
  for (const item of input.items) {
    for (const line of input.lines) {
      const key = pairKey(item.normalizedName, line.normalizedName);
      if (history.rejected.has(key)) continue;
      if (history.confirmed.has(key)) {
        all.push({ item, line, score: 100, source: "learned" });
        continue;
      }
      const score = scorePair(item.normalizedName, line.normalizedName);
      if (score >= MATCH_LOW) all.push({ item, line, score, source: "code" });
    }
  }
  const order = (a: Scored, b: Scored): number =>
    b.score - a.score ||
    a.item.position - b.item.position ||
    a.line.position - b.line.position ||
    (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0) ||
    (a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0);
  const sorted = [...all].sort(order);
  const usedItems = new Set<string>();
  const usedLines = new Set<string>();
  const pairs: PlannedPair[] = [];
  for (const s of sorted) {
    if (usedItems.has(s.item.id) || usedLines.has(s.line.id)) continue;
    usedItems.add(s.item.id);
    usedLines.add(s.line.id);
    pairs.push({
      itemId: s.item.id,
      lineId: s.line.id,
      score: s.score,
      source: s.source,
      ambiguous: s.score < MATCH_HIGH,
    });
  }
  // Candidații unui articol ambiguu: liniile cu scor ≥ MATCH_LOW care NU sunt luate de o pereche
  // sigură a altui articol (propunerea codului intră mereu, prima la scor egal).
  const strongLines = new Set(pairs.filter((p) => !p.ambiguous).map((p) => p.lineId));
  const ambiguous: AmbiguousItem[] = [];
  for (const p of pairs) {
    if (!p.ambiguous) continue;
    const candidates = sorted
      .filter((s) => s.item.id === p.itemId && !strongLines.has(s.line.id))
      .map((s) => s.line.id);
    const ids = [p.lineId, ...candidates.filter((id) => id !== p.lineId)].slice(
      0,
      MAX_AMBIGUOUS_CANDIDATES,
    );
    ambiguous.push({ itemId: p.itemId, candidateLineIds: ids });
  }
  return {
    pairs,
    unmatchedItemIds: input.items.filter((i) => !usedItems.has(i.id)).map((i) => i.id),
    unmatchedLineIds: input.lines.filter((l) => !usedLines.has(l.id)).map((l) => l.id),
    ambiguous,
  };
}
