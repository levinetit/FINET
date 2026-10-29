import "server-only";

/**
 * Magistrala actualizărilor live (Faza 8, ADR 0017): în memoria procesului `finet-web`, fără
 * serviciu extern și fără conexiuni la bază ținute deschise (pooler-ul Supabase în mod tranzacție
 * nu suportă LISTEN/NOTIFY). Un eveniment poartă DOAR tipul și id-ul obiectului (fără sume, nume,
 * descrieri); clientul recitește datele prin server, cu RLS.
 *
 * Publicul unui eveniment: toată gospodăria sau un singur utilizator (`onlyUserId`), de exemplu o
 * tranzacție dintr-un cont PERSONAL ajunge doar la proprietarul contului (ceilalți nu află nici
 * că a existat). Publicul îl calculează cel care publică, din datele pe care le-a scris.
 *
 * Starea stă pe `globalThis` (cheie `Symbol.for`): Next poate încărca modulul de mai multe ori
 * (rute compilate separat, reîncărcarea în dezvoltare), iar abonații și publicatorii trebuie să
 * vadă aceeași magistrală. Limitare asumată: o singură instanță web (ADR 0002); evenimentele
 * scrise de worker sau de CLI nu trec pe aici (clientul le vede la următoarea reîncărcare).
 */

export const LIVE_EVENT_TYPES = [
  "transaction",
  "transfer",
  "receipt",
  "split",
  "settlement",
  "member",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export type LiveEvent = Readonly<{
  householdId: string;
  type: LiveEventType;
  id: string;
  /** Doar acest utilizator primește evenimentul (altfel toți membrii gospodăriei). */
  onlyUserId?: string;
}>;

/** Ce ajunge efectiv la client: tipul și id-ul. */
export type LiveMessage = Readonly<{ type: LiveEventType; id: string }>;

/** Motivul închiderii forțate: `evicted` (plafonul per utilizator), `close` (apartenență schimbată). */
export type LiveCloseReason = "evicted" | "close";

type Subscriber = Readonly<{
  householdId: string;
  userId: string;
  send: (message: LiveMessage) => void;
  close: (reason: LiveCloseReason) => void;
}>;

type BusState = {
  subscribers: Set<Subscriber>;
  perUser: Map<string, number>;
};

const KEY = Symbol.for("finet.live-bus");

function state(): BusState {
  const g = globalThis as unknown as Record<symbol, BusState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { subscribers: new Set(), perUser: new Map() };
    g[KEY] = s;
  }
  return s;
}

/**
 * Plafoanele conexiunilor (decizia mea): câteva file per utilizator, un plafon global mic. La
 * plafonul per utilizator, conexiunea CEA MAI VECHE a lui e închisă (`evicted`) în favoarea celei
 * noi: o deconectare nedetectată (o filă închisă brusc) nu poate bloca utilizatorul. Plafonul global
 * refuză (429).
 */
export const LIVE_MAX_PER_USER = 4;
export const LIVE_MAX_TOTAL = 200;

export type Subscription = Readonly<{ unsubscribe: () => void }>;

/**
 * Înregistrează un abonat. `null` dacă s-a atins plafonul global (ruta răspunde 429); la plafonul
 * per utilizator, cel mai vechi abonat al lui primește `close("evicted")`. `close` trebuie să
 * apeleze `unsubscribe`; `unsubscribe` e idempotent (abort, închidere, evacuare).
 */
export function subscribeLive(
  householdId: string,
  userId: string,
  send: (message: LiveMessage) => void,
  close: (reason: LiveCloseReason) => void,
): Subscription | null {
  const s = state();
  const user = userId.toLowerCase();
  if ((s.perUser.get(user) ?? 0) >= LIVE_MAX_PER_USER) {
    // `Set` păstrează ordinea inserării: primul găsit e cel mai vechi.
    for (const old of s.subscribers) {
      if (old.userId !== user) continue;
      // Întâi scos din evidență (contorul scade o singură dată), apoi închis.
      s.subscribers.delete(old);
      const left = (s.perUser.get(user) ?? 1) - 1;
      if (left <= 0) s.perUser.delete(user);
      else s.perUser.set(user, left);
      try {
        old.close("evicted");
      } catch {
        // ignorat
      }
      break;
    }
  }
  if (s.subscribers.size >= LIVE_MAX_TOTAL) return null;
  const count = s.perUser.get(user) ?? 0;
  const sub: Subscriber = { householdId: householdId.toLowerCase(), userId: user, send, close };
  s.subscribers.add(sub);
  s.perUser.set(user, count + 1);
  let active = true;
  return {
    unsubscribe: () => {
      if (!active) return;
      active = false;
      // Deja scos (evacuat): contorul a fost scăzut atunci.
      if (!s.subscribers.delete(sub)) return;
      const left = (s.perUser.get(user) ?? 1) - 1;
      if (left <= 0) s.perUser.delete(user);
      else s.perUser.set(user, left);
    },
  };
}

/** Trimite evenimentul abonaților gospodăriei (sau doar lui `onlyUserId`). Nu aruncă. */
export function publishLive(event: LiveEvent): void {
  const household = event.householdId.toLowerCase();
  const only = event.onlyUserId?.toLowerCase();
  const message: LiveMessage = { type: event.type, id: event.id.toLowerCase() };
  for (const sub of state().subscribers) {
    if (sub.householdId !== household) continue;
    if (only !== undefined && sub.userId !== only) continue;
    try {
      sub.send(message);
    } catch {
      // Un abonat închis nu oprește livrarea către ceilalți.
    }
  }
}

/**
 * Închide imediat fluxurile unui utilizator pentru o gospodărie (`close`): după eliminare, plecare
 * sau comutarea gospodăriei active, ca evenimentele vechii gospodării să nu mai ajungă la el.
 */
export function closeLiveFor(householdId: string, userId: string): void {
  const household = householdId.toLowerCase();
  const user = userId.toLowerCase();
  for (const sub of [...state().subscribers]) {
    if (sub.householdId !== household || sub.userId !== user) continue;
    try {
      sub.close("close");
    } catch {
      // ignorat
    }
  }
}

/** Câte conexiuni are un utilizator (pentru teste și pentru plafon). */
export function liveConnectionsOf(userId: string): number {
  return state().perUser.get(userId.toLowerCase()) ?? 0;
}

/** Doar pentru teste: numărul total de abonați. */
export function liveSubscriberCount(): number {
  return state().subscribers.size;
}
