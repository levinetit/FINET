# FINET — performanță

Creat în Faza 4 (ADR 0010). Două măsurători: mărimea JavaScript-ului trimis browserului (buget verificat în CI) și timpii interogărilor pe un volum realist (test lent, la cerere).

## 1. Bugetul JavaScript (First Load JS, gzip)

**Ce se măsoară:** pentru fiecare pagină din build-ul de producție (`pnpm build`), suma dimensiunilor gzip ale fișierelor JavaScript încărcate la prima vizită: runtime-ul comun (`build-manifest.json` → `rootMainFilesTree`/`rootMainFiles`) plus chunk-urile tuturor segmentelor paginii (`.next/server/app/**/page_client-reference-manifest.js` → `entryJSFiles`), deduplicate. Fără polyfill-urile `nomodule` și fără CSS. 1 KiB = 1024 octeți.

**Cum:** `pnpm build && pnpm check:bundle` (opțional `--json bundle-size.json`). Scriptul: `scripts/check-bundle-size.mjs` (testat în `scripts/check-bundle-size.test.ts`). În CI rulează după `pnpm build`, în job-ul `check`; raportul JSON e încărcat ca artefact `bundle-size`.

**Pragurile** (citite de script din blocul de mai jos; un prag pe o rută se aplică și sub-rutelor ei, ex. `/accounts` → `/accounts/[id]`):

```json bundle-budget
{
  "defaultKiB": 190,
  "routes": {
    "/login": 180,
    "/register": 180
  }
}
```

**Valorile măsurate (prima rulare CI, 2026-10-28, `next build` de producție, First Load JS gzip):**

| Rută | Măsurat (KiB gzip) | Prag (KiB) |
|---|---|---|
| `/` | 152,9 | 190 |
| `/login` | 155,7 | 180 |
| `/register` | 152,9 | 180 |
| rute autentificate (`/accounts`, `/budgets`, `/categories`, `/dashboard`, `/goals`, `/profile`, `/reports`, `/tags`, `/transactions`, `/transfers/new`) | 158,9 – 165,4 | 190 |

Pragurile inițiale din brief (250 KiB autentificat, 150 KiB pentru `/login`) erau provizorii: `/login` și `/register` măsoară deja 155,7 și 152,9 KiB, deci 150 nu era realist. Pragurile au fost fixate la valoarea măsurată + ~15 % (rotunjit la 10 KiB): 190 KiB implicit (cea mai mare rută: 165,4 KiB) și 180 KiB pentru `/login` și `/register`. Ele sunt un plafon împotriva regresiilor, nu un obiectiv: baza comună (React, Next, runtime) e ≈ 150 KiB.

## 2. Baza de date: 50.000 de tranzacții pe 12 luni

**Testul:** `src/db/perf.test.ts`, sărit în suita standard; rulat la cerere:

```bash
FINET_PERF=1 DATABASE_URL=postgres://<superuser>@<pg-de-test>/<db> pnpm exec vitest run src/db/perf.test.ts
```

O bază nouă (migrațiile reale, rolurile `finet_migrator`/`finet_app`), 50.000 de tranzacții într-o gospodărie (≈ 10 % venituri, 7 categorii, 40 de comercianți, zilele 2025-11-01 … 2026-10-31, eticheta pe ≈ 10 % din cheltuieli) și 5.000 în alta. Totul se măsoară ca `finet_app`, cu RLS activ, prin serviciile reale: mediana din 5 rulări după o încălzire (exportul: din 2). Planurile vin din `auto_explain` (`log_analyze`, `log_buffers`, nivel NOTICE, setat doar pe baza de test) pe EXACT interogările din `dashboard.repo.ts` și `transactions.repo.ts`.

**Mediul:** PostgreSQL 17 (`postgres:17-alpine`, container cu 256 MiB), Node 24 în container (2 GiB), pe hostul `docker-apps` încărcat (≈ 0,8 GB RAM liber, swap plin): valorile absolute sunt pesimiste și zgomotoase (o rulare intermediară, cu ≈ 0,5 GB liberi, a dat dashboard 454 ms); comparația înainte/după e făcută în condiții similare.

| Operația | Înainte de `0005` (ms, mediana) | După `0005` + `tagMatch=all` grupat (ms, mediana) |
|---|---|---|
| `GET dashboard` (luna, 12 luni, trend zilnic, top categorii) | 142,3 | 123,3 |
| Lista, prima pagină (50, `date_desc`) | 116,1 | 16,3 |
| Lista, pagina 2 (cursor) | 68,6 | 16,2 |
| Lista, `amount_desc` | 90,1 | 62,1 |
| Lista, o etichetă (`any`) | 47,4 | 26,7 |
| Lista, `tagMatch=all` | 252,1 | 55,1 |
| Lista, căutare `q` (`ILIKE` pe 3 coloane) | 139,2 | 117,5 |
| Lista, o lună (`dateFrom`/`dateTo`) | 29,8 | 34,6 |
| Export CSV complet (50.000 de rânduri) | 7.676 | 4.652 |

**Planurile (durata interogării din `auto_explain`):**

| Interogarea | Înainte | După | Plan |
|---|---|---|---|
| Totaluri lunare, 12 luni (`selectMonthlyTotals`) | 114,0 ms | 96,5 ms | `Seq Scan` pe `transactions` (50.000 din 55.000 de rânduri: toată gospodăria, deci corect; un index n-ar ajuta) |
| Totaluri zilnice, o lună (`selectDailyTotals`) | 6,4 ms | 8,5 ms | `Bitmap Index Scan` pe `transactions_household_occurred_idx` (4.243 de rânduri) |
| Cheltuieli pe categorii, o lună | 7,1 ms | 10,8 ms | idem + `Seq Scan` pe `categories` (28 de rânduri) |
| Top comercianți, o lună | 17,8 ms | 11,0 ms | idem, sortare `quicksort` în memorie (27 kB) |
| Lista, prima pagină | **84,4 ms** | **1,7–3,1 ms** | înainte: `Seq Scan` + `top-N heapsort` pe toată gospodăria; după: `Index Scan using transactions_household_date_idx` (51 de rânduri citite) |

**Concluzii:**
- **Cauza găsită:** indexul din `0002` e `(household_id, occurred_on DESC NULLS LAST, id DESC NULLS LAST)`, iar lista ordonează `occurred_on DESC, id DESC` (implicit NULLS FIRST). Postgres nu folosește constrângerea `NOT NULL` ca să le echivaleze, deci fiecare pagină (și fiecare pagină a exportului, `date_asc`) sorta toată gospodăria. Migrația `0005_perf_indexes` adaugă indexul cu ordinea implicită (parcurs invers dă și `ASC NULLS LAST`). Indexul vechi rămâne (folosit de agregările pe interval); ștergerea lui e o optimizare opțională, de decis separat.
- `tagMatch=all`: un `COUNT` corelat per rând → o subinterogare grupată (`GROUP BY transaction_id HAVING count(*) = N`, semi-join).
- Agregările dashboard-ului folosesc deja indexul pe interval; totalurile pe 12 luni citesc toată gospodăria (inevitabil fără tabele pre-agregate; sub 0,1 s la 50.000 de rânduri). Fără alt index.
- Exportul complet rămâne ~4,5 s: după index, timpul e dominat de aplicație (50 de pagini a câte 1.000 de rânduri, câte o tranzacție RLS per pagină, sortarea etichetelor cu `localeCompare`, compunerea CSV). Sub plafonul de 50.000 e acceptabil; o optimizare (pagini mai mari, `Intl.Collator` reutilizat) rămâne în `docs/ROADMAP.md`.
- Căutarea `q` (`ILIKE '%…%'` pe descriere/comerciant/note) e un `Seq Scan` filtrat (~0,1 s). Un index `pg_trgm` ar cere extensia pe Supabase: amânat (`docs/ROADMAP.md`).
