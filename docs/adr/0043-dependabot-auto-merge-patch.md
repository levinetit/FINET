# ADR 0043: Auto-merge Dependabot pentru patch-uri

- **Stare:** propus. Activarea cere două setări de repo (mai jos); fără ele workflow-ul nu face nimic util sau, mai rău, unește fără CI.
- **Legături:** `.github/dependabot.yml`, `.github/workflows/dependabot-auto-merge.yml`, `.github/workflows/ci.yml` (`ci`, `backup-restore`), ADR 0002 (deploy manual din imagini CI).

## Decizie

Dependabot rulează săptămânal. Actualizările **patch** se grupează într-un PR per ecosistem (`npm-patch`, `actions-patch`, `docker-patch`, `docker-compose-patch`), iar workflow-ul `dependabot-auto-merge` activează auto-merge (squash) pe ele, doar după ce verificările cerute pe `main` trec.

### Ce se auto-merge-uiește

- Doar PR-uri deschise de `dependabot[bot]`, unde **fiecare** dependență are `version-update:semver-patch` (verificat pe lista completă, nu doar pe nivelul cel mai înalt al grupului).
- npm, github-actions, docker, docker-compose.

### Ce NU se auto-merge-uiește (PR-uri individuale, merge manual)

- Orice minor/major (grupul `dev-dependencies` rămâne doar pentru minor, tot manual).
- `better-auth`, `@better-auth/*`, `postgres`, `pg`, `drizzle-orm`, `drizzle-kit`, `drizzle-*` și imaginile docker `postgres` (inclusiv `*/postgres`). Sunt excluse din grupuri în `dependabot.yml` (rămân PR-uri separate) și blocate și în workflow (a doua plasă). Motiv: auth, driver și ORM ating datele și migrațiile; versiunea PostgreSQL se schimbă doar prin procedura din `docs/INFRA.md`.
- `@types/pg` și alte pachete cu nume apropiat NU sunt excluse (nu au fost cerute).

## Alegeri tehnice

- **`pull_request_target`, nu `pull_request`:** pe PR-urile Dependabot, `pull_request` primește GITHUB_TOKEN doar-citire, deci `gh pr merge --auto` ar eșua. `pull_request_target` rulează workflow-ul de pe `main` cu `contents: write` + `pull-requests: write`. Riscul acestui eveniment (executarea codului din PR) e evitat: nu există `checkout`, nu se execută nimic din PR, se citesc doar metadatele Dependabot. Condiția dublă pe `github.actor` și `pull_request.user.login` împiedică rularea pe PR-uri ale altora.
- `dependabot/fetch-metadata` e pinuit pe SHA complet (v2.5.0); valorile din PR trec prin `env`, nu sunt interpolate în script.
- **Merge-ul cu GITHUB_TOKEN nu declanșează alte workflow-uri** (regula GitHub contra buclelor). Efect: commit-ul de merge al unui patch nu pornește `ci` (push pe `main`) și nici `images` (imaginile se construiesc la push pe `main`). Acceptabil: PR-ul a trecut deja `ci` înainte de merge, iar următorul push uman pe `main` rulează ambele workflow-uri pe starea cumulată, deci imaginea de deploy include patch-urile. Deploy-ul rămâne manual și se face doar din imagini CI ale unui SHA cunoscut: nu deploya SHA-ul unui merge automat înainte să existe imaginea lui (rulează `images` manual sau așteaptă următorul push).

## Setări de repo necesare (le face operatorul)

1. Settings > General > „Allow auto-merge” = activat.
2. Branch protection (sau ruleset) pe `main` cu verificări obligatorii: `ci` și `backup-restore` (eventual și `pg-version`). **Fără aceasta, `gh pr merge --auto` unește imediat**, înainte de CI, pentru că PR-ul nu e blocat de nimic.
3. Opțional: „Automatically delete head branches”.

## Cum se oprește

- Oprire completă: ștergi `.github/workflows/dependabot-auto-merge.yml`.
- Oprire rapidă, fără commit: dezactivezi „Allow auto-merge” în setările repo-ului (workflow-ul va eșua la `gh pr merge`, PR-urile rămân deschise).
- Un PR deja pus în auto-merge: „Disable auto-merge” pe PR.
