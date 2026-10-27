# FINET — note de confidențialitate (modul `personal`)

Notă internă, nu politică de confidențialitate publică (aceea vine în `saas`, Faza 11). Datele prelucrate sunt financiare și sensibile pentru familie.

## Împuterniciți (procesatori)

| Furnizor | Ce vede / stochează | Regiune | Stare |
|---|---|---|---|
| **Cloudflare** (Tunnel, Access, WARP, DNS) | Decriptează traficul HTTPS la marginea rețelei, deci **vede datele în tranzit** (pagini, răspunsuri API, fișiere încărcate). Vede emailurile familiei (login Access, înrolare WARP) și metadate (IP, dispozitiv, ore). | Global (rețeaua Cloudflare); nu se garantează procesarea doar în UE pe planul gratuit | De confirmat de operator: planul, termenii DPA Cloudflare acceptați |
| **Supabase** | Baza de date PostgreSQL (toate datele financiare) și, din Faza 6, fișierele (bonuri, extrase) în bucket privat | UE, propunere Frankfurt `eu-central-1` (de confirmat la crearea proiectului) | Proiectul nu e creat |
| **VPS-ul docker-apps** (operatorul) | Containerele FINET, fișierele temporare și, cu `STORAGE_DRIVER=local`, fișierele în `/home/docker-apps/finet/storage`; backup-ul hostului pe Google Drive (rclone) poate include acest director | Locația VPS-ului: de completat de operator | De verificat: excluderea sau criptarea `/home/docker-apps/finet/` în backup-ul hostului |
| **Telegram** sau furnizorul SMTP | Doar textul notificărilor operaționale (fără sume, fără date ale familiei) | Furnizorul ales | Canalul nu e configurat |
| Furnizori AI externi | Doar cu consimțământ și buget (master prompt 3.6), Faza 6 | — | Neimplementat; `AI_MONTHLY_BUDGET=0` |

## Măsuri existente în cod (Faza 0)
- Fără Data API Supabase și fără chei `anon`/`service_role` în FINET (configurare: `ops/supabase/`).
- JWT Access verificat în aplicație (fail closed), deci cererile care ocolesc Cloudflare nu primesc date.
- `/api/health` nu întoarce versiuni, căi, host sau mesaje de eroare.
- Mesajele de eroare ale configurației nu conțin valori; niciun secret în `NEXT_PUBLIC_*` (scanare în CI).
- Notificările nu includ date financiare (regulă pentru scripturile care vor folosi `ops/notify/notify.sh`).

## TODO (operator / faze viitoare)
- **Retenția:** perioada pentru pozele bonurilor (`RECEIPT_IMAGE_RETENTION_DAYS`, Faza 6), pentru extrase, pentru loguri (`json-file` 3×10 MB pe container acum) și pentru backup-uri (Faza 3) — **TODO**.
- **Ștergerea:** regulile din master prompt 5.6 (Faza 2+) — **TODO**.
- Loguri fără date sensibile: de verificat la fiecare fază (încă nu există loguri de aplicație).
- Dacă aplicația trece în `saas`: politică publică, DPA-uri, lista împuterniciților, cookie-uri.
