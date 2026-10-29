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
| **Google (Gemini) prin LiteLLM-ul de pe gazdă** (`litellm-apps`, alias-urile `finet-vision-external`, `finet-text-external`) | Doar cu consimțământul `external_ai` activ al celui care încarcă și în bugetul lunar: **imaginea preprocesată a bonului** (JPEG re-encodat, fără EXIF/GPS/metadate, max. 2048 px) sau, pentru PDF cu text, **textul bonului** (≤ 12 000 de caractere); pentru categorisire, **numele normalizate ale produselor** și **numele categoriilor** gospodăriei. Niciodată: originalul, numele fișierului, emailul, id-uri, alte tranzacții. LiteLLM (pe VPS) vede aceleași date în tranzit. | Google (regiunea modelului, de confirmat de operator); LiteLLM pe VPS | Implementat în F6-B (ADR 0014); `AI_MONTHLY_BUDGET=0` (nimic nu pleacă) până la decizia operatorului |

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

## Documente încărcate (Faza 6, F6-A)
- **Ce se stochează:** fișierul original (poză sau PDF) în `/srv/finet/storage/households/<gospodărie>/documents/<id>`, pe VPS (driverul local; bucket-ul Supabase rămâne gol). Originalul **păstrează EXIF-ul, inclusiv locația GPS**, până la ștergere sau retenție (decizia mea: originalul se păstrează pentru exportul GDPR „fișierele originale”); doar copia trimisă la AI e fără metadate. În bază: tipul detectat, dimensiunea, SHA-256, hash-ul perceptual (dHash, nu permite reconstruirea imaginii), stările; nu se stochează numele fișierului.
- **Retenția:** `RECEIPT_IMAGE_RETENTION_DAYS` (implicit 180; 0 = niciodată) setează `expires_at` la încărcare; după expirare se șterge **doar fișierul** (datele extrase rămân). Jobul care o aplică: `admin cleanup-documents` (F6-C, ADR 0015), rulat zilnic de operator prin serviciul `finet-cleanup` (INFRA 4i); până la programarea lui, originalele rămân pe disc.
- **Fără consimțământ `external_ai`:** documentul se stochează, nu pleacă nicăieri (nu există model local în Faza 6), rămâne „așteaptă consimțământul”; bonul se poate introduce manual. Retragerea consimțământului oprește trimiterile viitoare.
- **Ștergerea** (5.6): rândul și bonul extras, apoi fișierul; tranzacțiile create din bon rămân, fără legătură. Auditul nu conține nume de fișiere sau conținut.
- **Jurnalul AI** (`ai_calls`): doar metadate (sarcina, modelul, durata, costul estimat, rezultatul), fără imagini sau text.
- **Afișarea (F6-C):** originalul se servește DOAR membrilor gospodăriei, prin `GET /api/v1/documents/{id}/file` (sesiune + RLS, `no-store`, `attachment`, nume generat de server); niciun link public sau semnat. Browserul nu trimite numele fișierului (formularul îl înlocuiește cu `bon-<n>`). Corecturile de categorie ale utilizatorului se păstrează ca alias pe numele normalizat al produsului (`product_aliases`, în gospodărie), ca bonurile următoare să le folosească.
- **Consimțământul în interfață (F6-C):** comutatorul „Citirea bonurilor cu AI” din `/profile` explică ce pleacă și către cine; pagina `/import` arată când lipsește.
- **Backup:** fișierele din `/srv/finet/storage` intră în backup-ul restic criptat al FINET (ADR 0009), nu în backup-ul `/home` al hostului.

## Pipeline-ul AI (Faza 6, F6-B; ADR 0014)
- **Ce pleacă, către cine:** Google (Gemini), prin LiteLLM-ul de pe gazdă (`litellm-apps`, cheie virtuală per aplicație, `finet_litellm_key`). Pleacă:
  - poza preprocesată (fără metadate);
  - sau textul unui PDF, plafonat la 12 000 de caractere. **Atenție:** un bon electronic poate avea tipărite date personale (numele clientului, numărul cardului de fidelitate, ultimele cifre ale cardului bancar); pleacă așa cum sunt pe bon;
  - pentru categorisire, numele normalizate ale produselor și numele categoriilor de cheltuieli ale gospodăriei.
- **Condiții:** consimțământul `external_ai` al celui care a încărcat (verificat la procesare, sub lock; retragerea oprește trimiterile următoare), bugetul lunar global `AI_MONTHLY_BUDGET` > 0 și neepuizat, plus AI configurat (`AI_BASE_URL` + cheia).
- **Ce rămâne local:** bonul extras (`receipts`, `receipt_lines`, `ocr_text`: textul PDF-ului sau numele citite, pentru căutare) în Supabase. `ai_calls` și `ai_budget_usage` țin doar metadate (sarcină, model, tokeni, cost estimat, durată, rezultat), fără conținut. Logurile workerului au doar coduri și contoare.
- **Retenția la furnizor:** după termenii Google/LiteLLM. De confirmat de operator: dacă LiteLLM înregistrează corpurile cererilor (jurnalele/spend logs cu conținut), opțiunea trebuie oprită pentru cheia FINET.

## Vizibilitatea între membrii unei gospodării (Faza 8, F8-A; ADR 0016)
- **Conturile personale** (`owner_user_id` = membrul) și tot ce ține de ele (tranzacții, transferuri — mai puțin jumătatea din contul comun —, etichete, reguli recurente, sumele din dashboard, rapoarte, bugete și exporturi) sunt vizibile DOAR proprietarului, impus în bază (RLS). Conturile comune le văd toți membrii.
- **Excepții încă vizibile tuturor membrilor în bază (nu prin interfață):** jurnalul de audit (`audit_events`: acțiunea, tipul și id-ul obiectului, fără sume sau texte, deci și id-urile obiectelor personale) și răspunsurile salvate ale cheilor de idempotență (`idempotency_keys.response`, 24 h; prin API se obțin doar cu cheia exactă, aleatoare). Restrângerea lor la autor e amânată (ADR 0016, punctul 10, m3).
- **Împărțirile și decontările** (cine a plătit, cât datorează fiecare, decontările și notele lor) le văd toți membrii gospodăriei, ca soldurile să fie aceleași pentru toți; descrierea, comerciantul și contul cheltuielii împărțite rămân private plătitorului.
- **Rămân vizibile tuturor membrilor (amânat):** documentele și bonurile încărcate (comerciant, total, produse), chiar dacă bonul a fost confirmat pe un cont personal; obiectivele; existența numelui unui cont personal (un nume deja folosit nu mai poate fi ales de alt membru). Recomandare: bonurile private nu se încarcă în gospodăria comună.
- **Invitațiile:** în bază se păstrează doar hash-ul tokenului, cine a invitat, rolul și datele; nu se stochează emailul invitatului. Linkul în clar se arată o singură dată celui care invită.
- **Decontările înregistrate de un owner** (risc acceptat, ADR 0016 §10): un owner poate stinge o datorie dintre alți doi membri; dacă apoi îl elimină pe creditor, acesta nu mai poate anula decontarea. Dialogul de eliminare arată decontările active ale membrului.
- **Plecarea / eliminarea:** nu sunt blocate de solduri; soldurile și decontările rămân în istoric, cu cel plecat marcat ca fost membru. Datele din conturile comune rămân gospodăriei; conturile personale ale celui plecat rămân în gospodărie, invizibile tuturor, și se șterg doar odată cu gospodăria (de revăzut la ștergerea contului, master prompt 5.6).

## Familia în interfață și actualizările live (Faza 8, F8-B; ADR 0017)
- **Ce vede fiecare membru pe `/family`:** numele și rolurile membrilor (fără emailuri), soldurile reciproce și decontările (cu notele), împărțirile (cine a plătit, cât datorează fiecare; fără descrierea cheltuielii), numele conturilor și bugetelor COMUNE și ale propriilor conturi/bugete personale. Foștii membri apar în solduri doar ca „fost membru”, fără nume.
- **Invitațiile:** linkul se arată o singură dată celui care invită, doar în pagină (nu se salvează în browser); înainte de acceptare, pagina de invitație nu arată numele gospodăriei. Tokenul apare în calea URL-ului, deci poate rămâne în istoricul browserului și în jurnalele de acces ale Cloudflare/Traefik (unică folosință, expiră în ≤ 7 zile).
- **Actualizările live (SSE):** evenimentele conțin doar tipul și id-ul obiectului, nu sume, nume sau descrieri; o tranzacție dintr-un cont personal nu generează eveniment pentru ceilalți membri. Evenimentele nu se stochează (memoria procesului web).

## TODO (operator / faze viitoare)
- **Retenția:** pozele bonurilor au `RECEIPT_IMAGE_RETENTION_DAYS` (implicit 180, F6-A; jobul de ștergere `cleanup-documents`, F6-C); rămân de decis: extrasele, pentru loguri (`json-file` 3×10 MB pe container acum) și pentru backup-uri (Faza 3) — **TODO**.
- **Ștergerea:** regulile din master prompt 5.6 (Faza 2+) — **TODO**.
- Loguri fără date sensibile: de verificat la fiecare fază (încă nu există loguri de aplicație).
- Dacă aplicația trece în `saas`: politică publică, DPA-uri, lista împuterniciților, cookie-uri.
