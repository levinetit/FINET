# FINET — instrucțiuni pentru agent

- Specificația completă și regulile permanente: `docs/FINET_MASTER_PROMPT.md` (secțiunile 1–6 se aplică mereu; fazele sunt în secțiunea 7).
- Aplicația Android: `docs/FINET_ANDROID_MASTER_PROMPT.md`.
- Starea fazelor: `docs/ROADMAP.md` (creat în Faza 0).
- Ghidul operatorului (infrastructură, Supabase, Cloudflare, secrete): `docs/GHID_CONSTRUIRE.md`.

Reguli scurte:
- O singură fază pe sesiune, pe un branch `phase/...`, cu PR către `main`. Niciodată push direct pe `main`.
- Fără secrete în cod, commit-uri, issue-uri sau PR-uri.
- Sumele în bani, ca numere întregi; niciodată float.
- Raportează exact comenzile rulate și rezultatele; nu pretinde verificări nefăcute.
- Pașii care cer acces la server, Supabase, Cloudflare sau secrete se scriu ca instrucțiuni pentru operator, nu se execută.
