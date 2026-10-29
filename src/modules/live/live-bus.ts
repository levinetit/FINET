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

type Subscriber = Readonly<{
  householdId: string;
  userId: string;
  send: (message: LiveMessage) => void;
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

/** Plafoanele conexiunilor (decizia mea): câteva file per utilizator, un plafon global mic. */
export const LIVE_MAX_PER_USER = 4;
export const LIVE_MAX_TOTAL = 200;

export type Subscription = Readonly<{ unsubscribe: () => void }>;

/**
 * Înregistrează un abonat. `null` dacă s-a atins plafonul per utilizator sau cel global (ruta
 * răspunde 429). `unsubscribe` e idempotent (se poate apela și la abort, și la închidere).
 */
export function subscribeLive(
  householdId: string,
  userId: string,
  send: (message: LiveMessage) => void,
): Subscription | null {
  const s = state();
  const user = userId.toLowerCase();
  const count = s.perUser.get(user) ?? 0;
  if (count >= LIVE_MAX_PER_USER || s.subscribers.size >= LIVE_MAX_TOTAL) return null;
  const sub: Subscriber = { householdId: householdId.toLowerCase(), userId: user, send };
  s.subscribers.add(sub);
  s.perUser.set(user, count + 1);
  let active = true;
  return {
    unsubscribe: () => {
      if (!active) return;
      active = false;
      s.subscribers.delete(sub);
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

/** Câte conexiuni are un utilizator (pentru teste și pentru plafon). */
export function liveConnectionsOf(userId: string): number {
  return state().perUser.get(userId.toLowerCase()) ?? 0;
}

/** Doar pentru teste: numărul total de abonați. */
export function liveSubscriberCount(): number {
  return state().subscribers.size;
}
