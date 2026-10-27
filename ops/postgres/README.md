# Versiunea PostgreSQL

`VERSION` conține versiunea majoră PostgreSQL folosită de CI (`.github/workflows/ci.yml`) și de mediul de dezvoltare (`.devcontainer/`). Trebuie să fie aceeași cu versiunea proiectului Supabase de producție (master prompt 3.5).

**Provizoriu:** valoarea `17` e o presupunere până când operatorul creează proiectul Supabase. După creare, se înlocuiește cu versiunea majoră afișată de Supabase (Settings → Infrastructure) și se actualizează imaginea din `.devcontainer/docker-compose.yml`.

La un upgrade major al proiectului Supabase, se actualizează acest fișier în același PR cu verificările de după upgrade (procedura din `docs/INFRA.md`).
