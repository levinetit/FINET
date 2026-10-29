// Pagina /offline (Faza 9, ADR 0020): afișează NUMĂRUL scanărilor în așteptare din IndexedDB
// (baza `finet-offline`, depozitul `scans`, aceeași schemă ca src/app/_lib/offline-scans-idb.ts).
// Nu citește pozele, nu creează baza dacă lipsește și nu trimite nimic în rețea. Când revine
// conexiunea, revine la pagina cerută.
"use strict";
(function () {
  const DB = "finet-offline";
  const VERSION = 1;
  const STORE = "scans";

  function show(text) {
    const el = document.getElementById("offline-scans");
    if (el) el.textContent = text;
  }

  function describe(pending, failed) {
    if (pending === 0 && failed === 0) return "Nu ai scanări în așteptare pe acest dispozitiv.";
    const parts = [];
    if (pending === 1) parts.push("1 încărcare în așteptare (offline)");
    else if (pending > 1) parts.push(pending + " încărcări în așteptare (offline)");
    if (failed === 1) parts.push("1 încărcare cu eroare");
    else if (failed > 1) parts.push(failed + " încărcări cu eroare");
    return parts.join(", ") + ". Se încarcă automat când revine conexiunea, din aplicație.";
  }

  function count() {
    if (typeof indexedDB === "undefined") {
      show("Scanările offline nu sunt disponibile în acest browser.");
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB, VERSION);
    } catch {
      show("Starea scanărilor nu poate fi citită.");
      return;
    }
    req.onupgradeneeded = function () {
      // Baza nu există: nu o creăm aici (anulăm crearea).
      req.transaction.abort();
    };
    req.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      show(describe(0, 0));
    };
    req.onsuccess = function () {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(STORE)) {
          show(describe(0, 0));
          db.close();
          return;
        }
        const all = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        all.onsuccess = function () {
          let pending = 0;
          let failed = 0;
          (all.result || []).forEach(function (scan) {
            if (scan && scan.state === "failed") failed++;
            else pending++;
          });
          show(describe(pending, failed));
          db.close();
        };
        all.onerror = function () {
          show("Starea scanărilor nu poate fi citită.");
          db.close();
        };
      } catch {
        show("Starea scanărilor nu poate fi citită.");
      }
    };
  }

  document.addEventListener("DOMContentLoaded", count);
  window.addEventListener("online", function () {
    // Pagina /offline poate fi afișată în locul oricărei rute: reîncarcă ruta cerută.
    window.location.reload();
  });
})();
