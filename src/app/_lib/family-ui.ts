/**
 * Funcții pure pentru interfața familiei (Faza 8): numele afișat al unui membru (inclusiv „fost
 * membru”), procentele scrise de utilizator → puncte de bază (exact, fără float: aceeași parsare ca
 * sumele, 1% = 100), momentele în fusul București și liniile soldurilor. Rulează la fel pe server
 * și în browser; testate în `family-ui.test.ts`.
 */

import { ro } from "@/messages/ro";

import { APP_TIME_ZONE, parseAmountInput } from "./ledger-ui";

export type MemberRef = Readonly<{ userId: string; name: string }>;

/** Numele pentru un id: „tu”, numele membrului, „fost membru” (fără nume: nu mai e vizibil). */
export function memberName(
  userId: string,
  members: readonly MemberRef[],
  meUserId: string,
): string {
  const found = members.find((m) => m.userId === userId);
  const base = found ? found.name : ro.family.formerMember;
  return userId === meUserId ? `${base} (${ro.family.you})` : base;
}

export type BasisPointsParse =
  Readonly<{ ok: true; basisPoints: number }> | Readonly<{ ok: false; message: string }>;

/**
 * Un procent scris (`33,33`, `50`, `12.5`) → puncte de bază întregi (3333, 5000, 1250). Folosește
 * parsarea sumelor (două zecimale, fără float): „unitățile minore” ale unui procent sunt exact
 * punctele de bază. Peste 100% sau negativ → mesaj.
 */
export function parsePercentInput(text: string): BasisPointsParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, basisPoints: 0 };
  const parsed = parseAmountInput(trimmed, "RON");
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (parsed.amountMinor < 0 || parsed.amountMinor > 10_000) {
    return { ok: false, message: ro.split.percentHint };
  }
  return { ok: true, basisPoints: parsed.amountMinor };
}

/** Punctele de bază ca text de procent (`3333` → `33,33`). */
export function formatBasisPoints(bp: number): string {
  // Doar operații pe text (fără împărțiri pe sume, `ui-rules.test.ts`).
  const digits = String(Math.max(0, Math.trunc(bp))).padStart(3, "0");
  const whole = String(Number(digits.slice(0, -2)));
  const rest = digits.slice(-2);
  return rest === "00" ? whole : `${whole},${rest}`;
}

const instantFormat = new Intl.DateTimeFormat("ro-RO", {
  timeZone: APP_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Un moment ISO afișat în București: `29.10.2026, 14:05`. */
export function formatInstant(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : instantFormat.format(d);
}

/** Linkul complet de invitație pentru copiere (originea paginii + `/join/<token>`). */
export function joinLink(origin: string, joinPath: string): string {
  return `${origin.replace(/\/+$/, "")}${joinPath}`;
}
