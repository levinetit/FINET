# ADR 0052: jurnalizare structurată în serverul web și stratul de indirecție pentru texte

- **Stare:** propus (modernizare 2026, pașii N și O).
- **Legături:** `src/lib/log.ts`, `src/messages/index.ts`, `src/worker/cli.ts` (formatul existent al workerului), `docs/PERFORMANCE.md` (bugetul JS și `ro.ts`), ADR 0031/0033 (limbile paginilor publice), decizia operatorului din 2026-11-01 (aplicația rămâne în română).

## Context

Workerul loga deja JSON pe o linie (`{ service, time, event, … }`), dar serverul web avea 13 apeluri `console.error` cu text liber; fără nivel, fără cod de eroare, greu de filtrat în Loki/Grafana sau în `docker logs`. Pentru limbi, `src/messages/ro.ts` (2.700 de linii) e importat static în ~130 de fișiere, iar orice traducere ar începe cu un refactor mecanic.

## Decizii

1. **`src/lib/log.ts`:** `log.info|warn|error(scope, event, fields?)` emite `{ time, level, scope, event, ...fields }` pe o linie, `info` pe stdout, restul pe stderr. Câmpurile sunt filtrate: doar șiruri (≤ 200), numere finite, booleeni, `null`; chei alfanumerice; `scope`/`event` normalizate. Regula 6.3 rămâne: niciun conținut din cereri, nicio sumă, niciun identificator personal — doar coduri (`errorCodeOf`: SQLSTATE sau `code`-ul driverului, altfel numele erorii). Toate apelurile `console.error` din `src/app`, `src/lib`, `src/modules` au fost înlocuite (rămân cele din `config-startup.ts`, care rulează înainte de orice, și logger-ul Better Auth, care primește deja doar nivel + mesaj intern).
2. **Fără metrici noi și fără error tracking extern** în această iterație: `/api/health` (db, storage, queue, disc) și `service_heartbeats` rămân semnalele; un exporter Prometheus sau Sentry ar adăuga dependențe și un canal nou de scurgere; decizia e a operatorului (stack-ul `monitoring/` de pe host nu e deployat).
3. **`src/messages/index.ts`:** `messagesFor(locale)` și tipul `Messages`, azi mereu `ro`. Componentele noi pot importa de aici; cele vechi rămân cum sunt (migrare treptată, fără risc). A doua limbă = un fișier cu aceeași formă (verificat de tip) + alegerea după `finet_lang`/preferința contului. Împărțirea `ro.ts` pe pagini (pentru bugetul JS) e primul pas concret, listat în `PERFORMANCE.md`.
4. **Nu se traduce nimic acum** (decizia operatorului). Formatele (date `zz.ll.aaaa`, sume `ro-RO`) rămân în `money.ts`/`planning-ui.ts`, independente de textele interfeței.

## Consecințe

- Logurile web și worker au același format; filtrarea pe `event` și `code` e posibilă fără parsare de text.
- Nicio schimbare de comportament pentru utilizator; `index.test.ts` păzește faptul că româna e implicită și singura.
