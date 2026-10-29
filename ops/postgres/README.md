# Versiunea PostgreSQL

`VERSION` conține versiunea majoră PostgreSQL folosită de CI (`.github/workflows/ci.yml`) și de mediul de dezvoltare (`.devcontainer/`). Trebuie să fie aceeași cu versiunea proiectului Supabase de producție (master prompt 3.5).

**Provizoriu:** valoarea `17` e o presupunere până când operatorul creează proiectul Supabase. După creare, se înlocuiește cu versiunea majoră afișată de Supabase (Settings → Infrastructure) și se actualizează imaginea din `.devcontainer/docker-compose.yml`.

La un upgrade major al proiectului Supabase, se actualizează acest fișier în același PR cu verificările de după upgrade (procedura din `docs/INFRA.md`).

## Upgrade major: încercarea locală (Faza 9, F9-B)

`upgrade-test.sh` restaurează un dump propriu (format custom, ca `ops/backup/backup.sh`) de pe un PostgreSQL efemer pe versiunea curentă într-unul pe versiunea următoare și compară amprenta (tabele, rânduri, RLS, politici, funcții, triggere, constrângeri, ACL, valorile de control „numărul și suma tranzacțiilor pe gospodărie”). Datele de control: `upgrade-seed.sql` (fictive). Rulat săptămânal de `.github/workflows/pg-next.yml` (plus testele pe versiunea următoare) și manual după `docs/INFRA.md` §7. Rezultatul încercării 17 → 18: `docs/reports/faza-9.md` (F9-B).

`VERSION` NU se schimbă după încercare: rămâne versiunea proiectului Supabase până la upgrade-ul real (pasul operatorului).
