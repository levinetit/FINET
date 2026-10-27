# ADR 0002 — Deploy în Docker pe VPS-ul docker-apps (nu nativ pe LXC 1999)

- **Stare:** acceptat (decizia operatorului, 2026-10-27)
- **Înlocuiește:** master prompt 3.1 (infrastructura țintă) și 3.2 „Deploy”, plus punctul „Unități systemd … vhost nginx” din Faza 0, în măsura descrisă mai jos.

## Context
- Master promptul prevedea rulare nativă (Node 24 + pnpm, unități systemd `web`/`worker`, nginx local pe `127.0.0.1`, `cloudflared` ca serviciu) pe containerul LXC 1999.
- LXC 1999 e gazda OpenClaw și are **5,1 GB liberi din 20 GB**, sub pragul de 8 GB cerut de Faza 0, fără Docker.
- VPS-ul `docker-apps` rulează deja ~50 de containere orchestrate cu Docker Compose/Portainer, are Traefik (`traefik-main`) cu TLS Let's Encrypt prin DNS-01 Cloudflare, un tunel Cloudflare (`cloudflare-tunnel`) pe rețeaua `apps` și un firewall allowlist. La 2026-10-27: ~56 GB liberi pe disc, RAM ~12 GB total, dar doar ~1,1–2,4 GB disponibili (host încărcat).

## Decizie
FINET rulează pe `docker-apps`, în containere noi construite din `Dockerfile`-ul repo-ului (imagine `finet`):
- `finet-web` (Next.js standalone, `node server.js`, user `node` uid 1000) și `finet-worker` (aceeași imagine; în Faza 0 un stub oprit implicit prin profilul `worker`);
- definite în `ops/docker/docker-compose.yml`, compose local (date și fișiere de mediu în `/srv/finet/`, în afara backup-ului de `/home` al hostului, vezi `docs/INFRA.md`);
- pe rețeaua externă `apps`, cu IP static, **fără porturi publicate pe host**;
- intrarea prin `cloudflare-tunnel` (recomandat) sau prin `traefik-main` (label-uri pregătite, oprite implicit);
- baza de date rămâne **Supabase**; dezvoltarea și CI folosesc PostgreSQL în container.

## Ce rămâne valabil din master prompt
Stack-ul aplicației (ADR 0001), Supabase (3.5), Cloudflare Access cu politica pe emailurile familiei și verificarea JWT în aplicație (3.1), WARP pentru telefoane, `/api/health`, canalul unic de notificări, regulile de bani, securitate și faze.

## Ce se schimbă
| Master prompt | Acum |
|---|---|
| 3.1: LXC 1999, fără Docker, Node nativ | VPS `docker-apps`, Docker; Node doar în imagine |
| 3.1: nginx local pe `127.0.0.1:80` | fără nginx pentru FINET; Traefik existent sau tunelul direct către `finet-web:3000` |
| 3.1: `cloudflared` ca serviciu systemd, `ops/cloudflare/config.yml` | tunelul existent `cloudflare-tunnel` (gestionat din panou); fără `config.yml` în repo (doar un exemplu în `ops/cloudflare/README.md`) |
| 3.2 Deploy: systemd `web` + `worker`, Docker alternativă | Docker Compose e calea principală; fără unități systemd |
| Faza 0: unități systemd, vhost nginx | `Dockerfile` + `ops/docker/docker-compose.yml` |
| Ghid 10.1: `/etc/finet/finet.env` (640, `root:finet`) | `/srv/finet/env/finet.env`, `finet.worker.env`, `finet.migrate.env` (600, root), câte unul pe serviciu prin `env_file` |
| „Cerere directă ocolind tunelul nu primește răspuns” | adevărat cu tunelul (nu există port/rută); cu Traefik, răspunsul e 403 din aplicație |
| Ollama/LiteLLM local „pe 127.0.0.1” | pe același host există `ollama` și `litellm-apps` pe rețeaua `apps` (de evaluat în Faza 6) |

## Consecințe
- Pozitiv: spațiu pe disc suficient, infrastructură TLS/tunel existentă, izolare prin container (rootfs read-only, `cap_drop: ALL`, `no-new-privileges`, limite de memorie/CPU).
- Negativ / riscuri: hostul e partajat și încărcat (RAM disponibilă mică) → limite modeste (web 512 MB, worker 256 MB) și risc de OOM sub presiune; FINET împarte rețeaua `apps` cu alte servicii (orice container de acolo poate cere `finet-web:3000`; aplicația rămâne fail-closed); presiunea pe disc e cauza cunoscută a mai multor incidente pe acest host → loguri limitate (`json-file`, 3×10 MB), date în Supabase.
- `docs/GHID_CONSTRUIRE.md` a fost aliniat la varianta Docker (PR separat, aprobat de operator). `docs/INFRA.md` rămâne sursa detaliată pentru deploy.
- Deploy-ul automat din GitHub (ghid, secțiunea 6) nu e implementat; deploy-ul îl face operatorul manual.
