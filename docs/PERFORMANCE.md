# FINET — performanță

Creat în Faza 4 (ADR 0010). Două măsurători: mărimea JavaScript-ului trimis browserului (buget verificat în CI) și timpii interogărilor pe un volum realist (test lent, la cerere).

## 1. Bugetul JavaScript (First Load JS, gzip)

**Ce se măsoară:** pentru fiecare pagină din build-ul de producție (`pnpm build`), suma dimensiunilor gzip ale fișierelor JavaScript încărcate la prima vizită: runtime-ul comun (`build-manifest.json` → `rootMainFilesTree`/`rootMainFiles`) plus chunk-urile tuturor segmentelor paginii (`.next/server/app/**/page_client-reference-manifest.js` → `entryJSFiles`), deduplicate. Fără polyfill-urile `nomodule` și fără CSS. 1 KiB = 1024 octeți.

**Cum:** `pnpm build && pnpm check:bundle` (opțional `--json bundle-size.json`). Scriptul: `scripts/check-bundle-size.mjs` (testat în `scripts/check-bundle-size.test.ts`). În CI rulează după `pnpm build`, în job-ul `check`; raportul JSON e încărcat ca artefact `bundle-size`.

**Pragurile** (citite de script din blocul de mai jos; un prag pe o rută se aplică și sub-rutelor ei, ex. `/accounts` → `/accounts/[id]`):

```json bundle-budget
{
  "defaultKiB": 250,
  "routes": {
    "/login": 150,
    "/register": 150
  }
}
```

**Valorile măsurate azi (2026-10-28): NOT RUN pe hostul agentului** (sub 1 GB RAM liber, swap plin: `pnpm build` nu se rulează local, regula Fazei 4). Scriptul a fost verificat pe structura reală a manifestelor Next 16.4.3 (Turbopack) dintr-un `.next/dev` existent — dimensiunile de acolo (≈ 845–860 KiB, cu HMR, devtools și cod neminificat) NU sunt reprezentative pentru producție și nu s-au folosit la praguri.

Pragurile de mai sus sunt **provizorii** (valorile din brief-ul Fazei 4: 250 KiB pentru paginile autentificate, 150 KiB pentru `/login`). Prima rulare a job-ului `check` în CI le calibrează: valorile din artefactul `bundle-size` se trec în tabelul de mai jos, iar pragurile se fixează la valoarea măsurată + o marjă de ~15 % (rotunjită la 10 KiB), fără a depăși 250/150.

| Rută | Măsurat (KiB gzip) | Prag (KiB) | Data |
|---|---|---|---|
| (toate) | de completat după prima rulare CI | 250 / 150 | — |

## 2. Baza de date: 50.000 de tranzacții pe 12 luni

Vezi secțiunea „Măsurători DB” de mai jos (testul `src/db/perf.test.ts`, rulat doar cu `FINET_PERF=1`).
