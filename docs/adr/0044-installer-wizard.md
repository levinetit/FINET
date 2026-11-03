# ADR 0044: installer interactiv (wizard) pentru un server nou

- **Stare:** propus.
- **Legături:** `ops/install/finet-install.sh`, `ops/install/test.sh`, `docs/INSTALL.md`, `docs/INFRA.md` (§3–§6), `ops/deploy/pull-images.sh`, `docs/BACKUP.md`, ADR 0002 (deploy Docker pe VPS), constatarea N1 (secrete în fișiere, nu în `environment`), LOW-1 (checkout root-owned pentru `run-backup.sh`).

## Context

Instalarea pe un server nou era o listă de ~40 de comenzi manuale în `docs/INFRA.md`, `ops/supabase`, `ops/cloudflare` și `docs/BACKUP.md`. Fiecare pas are o capcană documentată (permisiuni `1000:1000 0400`, URL-ul workerului pe alt port, `docker-compose.ask.yml` cât `AI_ASK=1`, cron fără `crontab -`, checkout root-owned). Utilizatorul a cerut o instalare automată, cu wizard.

## Decizii

1. **Un singur script POSIX `sh`**, rulat cu `sudo sh`, nu bash. Pe Debian `sh` este `dash`, care nu are `read -s`; secretele se citesc cu `stty -echo` + `read -r` din `/dev/tty`, cu restaurarea terminalului în `trap` (EXIT/INT/TERM/HUP). `shellcheck -s sh` este poarta de calitate (SC3045 prinde `read -s`). Valorile secrete trăiesc doar în variabile ale shell-ului și ajung în fișiere prin `printf '%s' "$v" | install ... /dev/stdin` (`printf` e builtin, deci valoarea nu apare în `argv`); cele generate merg direct din `openssl` în fișier.
2. **`whiptail`/`dialog` dacă există și avem terminal, altfel prompturi text** (fallback obligatoriu). Secretele se cer întotdeauna prin `stty`, nu prin TUI.
3. **Trei moduri:** instalare nouă, mutare (`rsync -aHAX --numeric-ids` peste SSH, cu `--backup --suffix=.bak-<data>`; secretul Better Auth se compară cu `sha256` pe ambele capete și nu se regenerează; migrațiile trebuie să dea „aplicate acum 0") și doar verificare (`--check`/`--dry-run`: fiecare scriere trece prin `act`, care în verificare doar anunță).
4. **Neinteractiv prin `--answers`**: parsat pe o listă de chei permise (nu se `source`-ază), fără niciun prompt (cheie lipsă fără implicit = eroare), fișier cu secrete refuzat dacă nu e `600`. Folosit de teste și de automatizări; valorile sunt ale operatorului.
5. **Imaginile vin doar din CI.** Implicit: ultimul commit de pe `main` cu rulare `images` (`event=push`, `success`) ale cărei trei artefacte (`web`, `tools`, `backup`) nu au expirat; `pull-images.sh` rămâne autoritatea pentru proveniență (refuză `workflow_dispatch` și forkuri). Tokenul GitHub: prompt ascuns, fișier temporar `600` în `mktemp -d`, trimis `curl -K -` (antetul pe stdin), șters la ieșire, păstrat în `/srv/finet/github-token` doar la alegerea operatorului. Instalarea refuză să lase Compose să construiască local: verifică `docker image inspect` pentru cele trei imagini și folosește `--no-build`.
6. **O singură listă `-f` pentru toate apelurile `docker compose`** (de bază, plus `docker-compose.ask.yml` când `AI_ASK=1`). `finet-worker` depinde de `finet-web`; un `up` fără fișierul „ask" ar recrea `finet-web` fără secretul cheii dedicate. Același lucru în liniile de cron.
7. **Checkout root-owned în `/srv/finet/src`**, la același SHA ca imaginile, cu verificarea `find -perm /022` (LOW-1): cron-ul rulează scripturi din el ca root, iar `run-backup.sh` refuză un checkout scriibil.
8. **Cron: `/etc/cron.d/finet`, nu `crontab -`.** `crontab -` înlocuiește tot crontab-ul root (regulă fermă a operatorului, precedent: patru joburi pierdute). Fișier dedicat (`root:root 644`, fără punct în nume, cu `SHELL`, `PATH` și coloana `root`); duplicatele față de `crontab -l -u root` și de alte fișiere din `cron.d` se detectează (citire) și se sar. Testul de CI interzice un `crontab -` activ în script. `cleanup-idempotency` (04:15) rămâne opțional și implicit oprit: nu e în producția actuală.
9. **`cloudflared` cu `--token-file`** (verificat în sursa cloudflared: `--token-file` / `TUNNEL_TOKEN_FILE`, citit doar dacă `--token` lipsește). `cloudflared service install <token>` ar pune tokenul în `argv` și în unitate; un container cu token în `environment` ar repeta N1. Unitatea proprie `finet-cloudflared.service` are `ExecStart ... --token-file /etc/finet-cloudflared/tunnel.token` (root `600`). Binarul se descarcă din release-ul GitHub oficial doar la cerere, fără o sumă de referință (se afișează `sha256`); Cloudflare Access și ruta rămân manuale (nu avem chei API).
10. **AI opțional, fără valori de producție implicite.** `AI_BASE_URL` nu are implicit (cel din modele este al LiteLLM-ului de pe docker-apps); cu AI oprit se comentează în `finet.worker.env`. Compose montează `finet_litellm_key` la worker necondiționat și `config.ts` refuză un fișier gol, deci cu AI oprit se scrie o valoare de umplere (`ai-dezactivat-fara-cheie`, nefolosită: fără `AI_BASE_URL` pasul AI nu rulează). `finet_ask_litellm_key` se creează doar cu `AI_ASK=1`.
11. **Rețea configurabilă:** `docker-compose.yml` primește `name: ${FINET_APPS_NETWORK:-apps}` pe rețeaua externă (schimbare compatibilă: implicit rămâne `apps`); numele, subnetul și IP-urile merg în `compose.env`.
12. **Parola utilizatorului** se generează în installer și se trimite prin `--password-stdin`; se afișează o singură dată pe `/dev/tty`, niciodată în log sau pe stdout (în `--answers` trebuie dată explicit). Parola restic: generată sau dată, același tratament; fișierul secret e `1000:1000 0400` (cum cere compose pentru montarea ca secret), nu `root 600`: un fișier `root 600` n-ar fi citibil de uid 1000 din container.
13. **Logul** se ține într-un director temporar `600` și se copiază la final în `/srv/finet/install-<data>.log` (`root 600`). Înainte de copiere, installer-ul caută în log fiecare valoare secretă (prin `grep -F -f` pe un fișier temporar, nu prin argumente) și șterge logul dacă găsește una.

## Teste

`ops/install/test.sh` (în `pnpm test:ops` și în jobul `backup-restore` din CI, într-un container Debian, cu `shellcheck`): reguli statice, unități, `--check` cu stub-uri (nimic scris, doar comenzi Docker de citire, niciun secret în stdout/stderr/log/argv), instalare reală cu stub-uri (permisiuni, parolă prin stdin, a doua rulare fără nicio modificare) și mutare cu `rsync`/`ssh` simulate.

## Consecințe și limite

- **Nerulat pe un server gol, cu Docker, Supabase și Cloudflare reale.** Stub-urile dovedesc logica și permisiunile, nu comportamentul lui Docker (de exemplu pornirea reală a containerelor, `pull-images.sh` real, `/api/health` real sau acceptarea certificatului de către bază). Primul rulaj real trebuie făcut cu `--check` și urmărit.
- Testul de conexiune la bază folosește `postgres` din imaginea `tools` și elimină `sslmode` din URL pentru a trece `ssl: { ca, rejectUnauthorized }`, ca `src/lib/db-client.ts`; dacă acel client se schimbă, testul trebuie aliniat.
- Destinațiile de backup S3/SFTP nu sunt acoperite (doar rclone, decizia operatorului); rămân în `docs/BACKUP.md`.
- Pașii din Supabase și Cloudflare rămân ai operatorului: nu există chei API pentru ele.
