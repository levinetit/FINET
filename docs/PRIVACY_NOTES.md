# FINET — note de confidențialitate (modul `personal`)

Notă internă, nu politică de confidențialitate publică (aceea vine în `saas`, Faza 11). Datele prelucrate sunt financiare și sensibile pentru familie.

## Împuterniciți (procesatori)

| Furnizor | Ce vede / stochează | Regiune | Stare |
|---|---|---|---|
| **Cloudflare** (Tunnel, Access, WARP, DNS) | Decriptează traficul HTTPS la marginea rețelei, deci **vede datele în tranzit** (pagini, răspunsuri API, fișiere încărcate). Vede emailurile familiei (login Access, înrolare WARP) și metadate (IP, dispozitiv, ore). | Global (rețeaua Cloudflare); nu se garantează procesarea doar în UE pe planul gratuit | De confirmat de operator: planul, termenii DPA Cloudflare acceptați |
| **Supabase** | Baza de date PostgreSQL (toate datele financiare) și, din Faza 6, fișierele (bonuri, extrase) în bucket privat | UE, Irlanda (`eu-west-1`) | Proiect creat la 2026-10-27; SSL obligatoriu, acces la bază doar de la IP-ul VPS-ului; bucket privat `finet-docs` (gol) |
| **VPS-ul docker-apps** (operatorul) | Containerele FINET, fișierele temporare și, cu `STORAGE_DRIVER=local`, fișierele în `/srv/finet/storage`; secretele ca fișiere în `/srv/finet/secrets/` (`1000:1000 0400`, director root 700), montate prin `secrets:` | Locația VPS-ului: de completat de operator | `/srv/finet/` e în afara backup-ului hostului (vezi mai jos); din T7 secretele FINET nu mai ajung în configurația containerelor din arhiva necriptată a `/home/docker` |
| **Google Drive** (backup-ul hostului, rclone) | Tot `/home`, zilnic: o copie criptată (`GdriveCrypt:home`) și una **necriptată** (`Gdrive:vpnde/home`), plus duminica o arhivă necriptată a `/home/docker` | Google (global) | FINET nu mai are date sub `/home`; vezi „Backup-ul hostului” |
| **Telegram** sau furnizorul SMTP | Doar textul notificărilor operaționale (fără sume, fără date ale familiei) | Furnizorul ales | Canalul nu e configurat |
| Furnizori AI externi | Doar cu consimțământ și buget (master prompt 3.6), Faza 6 | — | Neimplementat; `AI_MONTHLY_BUDGET=0` |

## Măsuri existente în cod (Faza 0)
- Fără Data API Supabase și fără chei `anon`/`service_role` în FINET (configurare: `ops/supabase/`).
- JWT Access verificat în aplicație (fail closed), deci cererile care ocolesc Cloudflare nu primesc date.
- `/api/health` nu întoarce versiuni, căi, host sau mesaje de eroare.
- Mesajele de eroare ale configurației nu conțin valori (nici conținutul sau calea fișierelor `*_FILE`); niciun secret în `NEXT_PUBLIC_*` (scanare în CI).
- Secretele intră în containere ca fișiere (`*_FILE`), nu ca variabile de mediu (N1).
- TLS spre Supabase cu `sslmode=verify-full` și CA-ul Supabase impus din cod (`DATABASE_CA_FILE`).
- Notificările nu includ date financiare (regulă pentru scripturile care vor folosi `ops/notify/notify.sh`).

## Backup-ul hostului (constatare F2, 2026-10-27)
- Scripturile de backup ale hostului (`backup_home_gdrive.sh`, criptat, și `backup_home_gdrive_clar.sh`, **necriptat**) fac `rclone sync /home` pe Google Drive cu un filtru care nu exclude nimic FINET. Un director FINET sub `/home` (bonuri, extrase, fișiere `.env`) ar ajunge zilnic pe Drive, inclusiv în clar.
- **Decizia:** datele și secretele FINET stau în `/srv/finet/` (`env/`, `storage/`, `compose/`, `ca/`), în afara `/home`. Backup-ul propriu, criptat (restic: `pg_dump` + fișiere), vine în Faza 3.
- **N1, închis tehnic (T7):** arhiva săptămânală necriptată a `/home/docker` conține `config.v2.json` al fiecărui container. Secretele FINET (URL-urile bazei, tokenul de sănătate) sunt acum fișiere montate prin `secrets:`, deci în `config.v2.json` apare doar calea lor, iar `env_file` are doar valori nesecrete.
- **Rămâne deschis (operator, în afara FINET):** aceeași arhivă conține mediul **altor** containere de pe host și logurile `json-file` (inclusiv ale FINET, fără secrete). Variante: excluderea `/home/docker/containers` din arhivă sau criptarea arhivei.
- Verificare după deploy: `sudo rclone ls Gdrive:vpnde/home | grep -i finet` (și `GdriveCrypt:home`) nu arată fișiere FINET.

## Statistici de utilizare și URL-uri (Faza 2, revizuirea F2)
- `client_installations` și `app_events` se scriu doar cu consimțământul `usage_stats` activ; la revocare (`PUT /api/v1/me/consents` cu `usageStats: false`) instalările și evenimentele utilizatorului se **șterg**. Cel mult 20 de instalări per utilizator.
- **Retenția evenimentelor (TODO, Faza 9):** 13 luni, apoi agregare pe zi și versiune și ștergere (6.5); azi rămân până la revocare sau la ștergerea contului.
- **Căutarea în URL (LOW-3):** parametrul `q` din `GET /api/v1/transactions` (și din pagina de tranzacții) e în URL. Aplicația nu loghează URL-uri sau query string-uri (logurile ei au doar mesaje fixe), dar Cloudflare (tunel/Access), Traefik și eventualele proxy-uri pot înregistra URL-urile complete în jurnalele lor. Recomandare pentru operator: fără jurnale de acces cu query string pe hostname-ul FINET. Alternativă într-o fază viitoare: `POST /api/v1/transactions/search`.

## TODO (operator / faze viitoare)
- **Retenția:** perioada pentru pozele bonurilor (`RECEIPT_IMAGE_RETENTION_DAYS`, Faza 6), pentru extrase, pentru loguri (`json-file` 3×10 MB pe container acum) și pentru backup-uri (Faza 3) — **TODO**.
- **Ștergerea:** regulile din master prompt 5.6 (Faza 2+) — **TODO**.
- Loguri fără date sensibile: de verificat la fiecare fază (încă nu există loguri de aplicație).
- Dacă aplicația trece în `saas`: politică publică, DPA-uri, lista împuterniciților, cookie-uri.
