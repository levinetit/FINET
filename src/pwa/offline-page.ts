/**
 * Pagina `/offline` (Faza 9, ADR 0020): HTML static, fără sesiune și fără date, pus în cache de
 * service worker la instalare și afișat la o navigare eșuată din lipsă de rețea.
 *
 * De ce nu e o pagină React: un răspuns din cache are nonce-ul CSP „înghețat” și ar trimite la
 * chunk-uri Next care pot lipsi din cache. Pagina folosește DOAR fișiere externe de pe aceeași
 * origine (`/pwa/offline.css`, `/pwa/offline.js`, permise de `'self'`), fără `<script>`/`<style>`
 * inline și fără atribute `style=` (testat în `offline-page.test.ts`). Scriptul citește din
 * IndexedDB doar NUMĂRUL scanărilor în așteptare (fără poze, fără previzualizări).
 */
export const OFFLINE_HTML = `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#1f45b8">
<title>Fără conexiune · FINET</title>
<link rel="stylesheet" href="/pwa/offline.css">
<link rel="icon" href="/icons/icon-192.png" type="image/png">
<script src="/pwa/offline.js" defer></script>
</head>
<body>
<main id="continut" class="offline">
<p class="eyebrow">FINET</p>
<h1>Nu există conexiune la internet</h1>
<p>Pagina cerută nu poate fi încărcată fără rețea. Datele tale nu sunt păstrate pe telefon, deci nu pot fi afișate offline.</p>
<p>Bonurile scanate fără semnal (în pagina <strong>Scanează</strong>, deschisă înainte să pierzi conexiunea) se păstrează pe acest dispozitiv și se încarcă singure când revine internetul.</p>
<section aria-labelledby="scanari-titlu" class="card">
<h2 id="scanari-titlu">Scanări în așteptare</h2>
<p id="offline-scans" role="status" aria-live="polite" data-testid="offline-scans">Se verifică…</p>
</section>
<p><a class="button" href="/dashboard" data-testid="offline-retry">Deschide FINET</a></p>
</main>
</body>
</html>
`;
