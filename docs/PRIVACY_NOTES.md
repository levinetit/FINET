# FINET — note de confidențialitate (modul `personal`)

Notă internă, nu politică de confidențialitate publică (aceea vine în `saas`, Faza 11). Datele prelucrate sunt financiare și sensibile pentru familie.

## Împuterniciți (procesatori)

| Furnizor | Ce vede / stochează | Regiune | Stare |
|---|---|---|---|
| **Cloudflare** (Tunnel, Access, WARP, DNS) | Decriptează traficul HTTPS la marginea rețelei, deci **vede datele în tranzit** (pagini, răspunsuri API, fișiere încărcate). Vede emailurile familiei (login Access, înrolare WARP) și metadate (IP, dispozitiv, ore). | Global (rețeaua Cloudflare); nu se garantează procesarea doar în UE pe planul gratuit | De confirmat de operator: planul, termenii DPA Cloudflare acceptați |
| **Supabase** | Baza de date PostgreSQL (toate datele financiare) și, din Faza 6, fișierele (bonuri, extrase) în bucket privat | UE, propunere Frankfurt `eu-central-1` (de confirmat la crearea proiectului) | Proiectul nu e creat |
| **VPS-ul docker-apps** (operatorul) | Containerele FINET, fișierele temporare și, cu `STORAGE_DRIVER=local`, fișierele în `/srv/finet/storage`; secretele în `/srv/finet/env/` (600, root) | Locația VPS-ului: de completat de operator | `/srv/finet/` e în afara backup-ului hostului (vezi mai jos); rămâne arhiva necriptată a `/home/docker` (configurația containerelor, cu secretele din mediu) |
| **Google Drive** (backup-ul hostului, rclone) | Tot `/home`, zilnic: o copie criptată (`GdriveCrypt:home`) și una **necriptată** (`Gdrive:vpnde/home`), plus duminica o arhivă necriptată a `/home/docker` | Google (global) | FINET nu mai are date sub `/home`; vezi „Backup-ul hostului” |
| **Telegram** sau furnizorul SMTP | Doar textul notificărilor operaționale (fără sume, fără date ale familiei) | Furnizorul ales | Canalul nu e configurat |
| Furnizori AI externi | Doar cu consimțământ și buget (master prompt 3.6), Faza 6 | — | Neimplementat; `AI_MONTHLY_BUDGET=0` |

## Măsuri existente în cod (Faza 0)
- Fără Data API Supabase și fără chei `anon`/`service_role` în FINET (configurare: `ops/supabase/`).
- JWT Access verificat în aplicație (fail closed), deci cererile care ocolesc Cloudflare nu primesc date.
- `/api/health` nu întoarce versiuni, căi, host sau mesaje de eroare.
- Mesajele de eroare ale configurației nu conțin valori; niciun secret în `NEXT_PUBLIC_*` (scanare în CI).
- Notificările nu includ date financiare (regulă pentru scripturile care vor folosi `ops/notify/notify.sh`).

## Backup-ul hostului (constatare F2, 2026-10-27)
- Scripturile de backup ale hostului (`backup_home_gdrive.sh`, criptat, și `backup_home_gdrive_clar.sh`, **necriptat**) fac `rclone sync /home` pe Google Drive cu un filtru care nu exclude nimic FINET. Un director FINET sub `/home` (bonuri, extrase, fișiere `.env`) ar ajunge zilnic pe Drive, inclusiv în clar.
- **Decizia:** datele și secretele FINET stau în `/srv/finet/` (`env/`, `storage/`, `compose/`, `ca/`), în afara `/home`. Backup-ul propriu, criptat (restic: `pg_dump` + fișiere), vine în Faza 3.
- **Rămâne deschis (operator):** arhiva săptămânală necriptată a `/home/docker` (data-root-ul Docker) conține `config.v2.json` al fiecărui container, adică și variabilele de mediu FINET (URL-urile bazei cu parole, tokenuri), plus logurile `json-file`. De exclus `/home/docker/containers` din arhivă sau de criptat arhiva; pe termen lung, secrete Docker montate ca fișiere (`docs/ROADMAP.md`).
- Verificare după deploy: `sudo rclone ls Gdrive:vpnde/home | grep -i finet` (și `GdriveCrypt:home`) nu arată fișiere FINET.

## TODO (operator / faze viitoare)
- **Retenția:** perioada pentru pozele bonurilor (`RECEIPT_IMAGE_RETENTION_DAYS`, Faza 6), pentru extrase, pentru loguri (`json-file` 3×10 MB pe container acum) și pentru backup-uri (Faza 3) — **TODO**.
- **Ștergerea:** regulile din master prompt 5.6 (Faza 2+) — **TODO**.
- Loguri fără date sensibile: de verificat la fiecare fază (încă nu există loguri de aplicație).
- Dacă aplicația trece în `saas`: politică publică, DPA-uri, lista împuterniciților, cookie-uri.
