"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ro } from "@/messages/ro";

/**
 * Actualizările live între membri (Faza 8, ADR 0017): `EventSource` pe `GET /api/v1/events`. Un
 * eveniment poartă DOAR `{ type, id }`; la primire pagina își recitește datele pe server
 * (`router.refresh()`: componentele server citesc prin aceleași servicii, cu RLS-ul utilizatorului
 * curent), cu o grupare de 400 ms și doar cât fila e vizibilă (altfel la revenire).
 *
 * Rezerva: dacă fluxul nu se poate deschide de 3 ori la rând (proxy care bufferizează, 429, rețea),
 * pagina trece pe interogare periodică (reîncărcarea datelor la 60 s, doar cu fila vizibilă) și
 * reîncearcă fluxul la 5 minute; la fel la `evicted` (alte file ale utilizatorului au luat cele 4
 * conexiuni). Evenimentul `close` (sesiune/apartenență schimbate) și `reconnect` (durata maximă a
 * fluxului) redeschid conexiunea.
 */

const TYPES = new Set(["transaction", "transfer", "receipt", "split", "settlement", "member"]);
const FALLBACK_POLL_MS = 60_000;
const FALLBACK_RETRY_MS = 5 * 60_000;

export function LiveUpdates() {
  const router = useRouter();
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let failures = 0;
    let stopped = false;
    let pendingWhileHidden = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const visible = () => document.visibilityState === "visible";
    const refreshNow = () => {
      router.refresh();
      setAnnounce(ro.family.liveUpdated);
    };
    const schedule = () => {
      if (!visible()) {
        pendingWhileHidden = true;
        return;
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refreshNow, 400);
    };

    const startFallback = () => {
      if (poll) return;
      poll = setInterval(() => {
        if (visible()) router.refresh();
      }, FALLBACK_POLL_MS);
      retry = setTimeout(() => {
        if (poll) clearInterval(poll);
        poll = undefined;
        failures = 0;
        connect();
      }, FALLBACK_RETRY_MS);
    };

    function connect() {
      if (stopped) return;
      source?.close();
      const es = new EventSource("/api/v1/events");
      source = es;
      es.addEventListener("ready", () => {
        failures = 0;
      });
      es.addEventListener("change", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as unknown;
          if (
            data &&
            typeof data === "object" &&
            TYPES.has(String((data as { type?: unknown }).type))
          ) {
            schedule();
          }
        } catch {
          // Mesaj nevalid: ignorat.
        }
      });
      const reopen = (delay: number) => {
        es.close();
        if (retry) clearTimeout(retry);
        retry = setTimeout(connect, delay);
      };
      // Sesiunea sau gospodăria s-au schimbat: o nouă conexiune (sau 401 → rezerva).
      es.addEventListener("close", () => reopen(1_000));
      es.addEventListener("reconnect", () => reopen(0));
      // Prea multe file deschise: o filă mai nouă a luat conexiunea; aceasta trece pe rezervă
      // (fără reconectare imediată, altfel filele și-ar lua conexiunea una alteia în buclă).
      es.addEventListener("evicted", () => {
        es.close();
        startFallback();
      });
      es.onerror = () => {
        // Cât timp `readyState` e CONNECTING, browserul reîncearcă singur (`retry: 5000`).
        if (es.readyState !== EventSource.CLOSED) return;
        failures += 1;
        if (failures >= 3) {
          es.close();
          startFallback();
        } else {
          reopen(5_000 * failures);
        }
      };
    }

    const onVisible = () => {
      if (visible() && pendingWhileHidden) {
        pendingWhileHidden = false;
        refreshNow();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (debounce) clearTimeout(debounce);
      if (retry) clearTimeout(retry);
      if (poll) clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="live-status">
      {announce}
    </p>
  );
}
