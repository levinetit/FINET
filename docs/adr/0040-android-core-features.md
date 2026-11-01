# ADR 0040: clientul Android — funcții de bază (Faza Android C)

- **Stare:** propus în branch `feature/android-c`. Continuă ADR 0038 și 0039. Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md` §7, §8 (Faza C), §9.
- **Legături:** `docs/API.md`, `docs/openapi.json`.

## Decizii

1. **Clientul nu calculează nimic financiar.** Totaluri, solduri, procente, comparația cu luna trecută și semaforul bugetelor vin de la server (`/dashboard`, `/accounts`, `/budgets/status`, `/goals`, `/reports/monthly`) și se afișează ca atare, formatate românește (`1.234,56 lei`). Singurele calcule locale sunt de desen (lățimea unei bare). Paritatea cu web-ul rezultă din construcție și din aceleași reguli de formatare și parsare ca pe web (Faza A); verificarea pe backendul real rămâne deschisă.
2. **Date simulate eliminate din aplicație.** `mock_data.dart`, banda „Date simulate” și `USE_MOCK_DATA` dispar; `API_BASE_URL` e obligatoriu. Serverul simulat există doar în teste (`test/support/fake_server.dart`).
3. **Modele scrise de mână** după `docs/openapi.json`, cu citire strictă (un câmp lipsă sau de alt tip devine „răspuns neașteptat”, niciodată o valoare inventată). Generarea din OpenAPI (`freezed`/`json_serializable`) rămâne o îmbunătățire viitoare, când contractul crește.
4. **Tranzacții:** listă paginată cu cursor (30 pe pagină, încărcare la capătul listei), căutare cu pauză de 400 ms, filtre (tip, cont, categorie, perioadă). Un răspuns întârziat al unei liste vechi (alte filtre) nu o înlocuiește pe cea nouă. Rândurile unui transfer sunt doar de citit (API-ul nu le editează individual). Ștergerea cere confirmare.
5. **Idempotență:** formularul de tranzacție generează un `Idempotency-Key` o singură dată; apăsări repetate sau reîncercări trimit aceeași cheie, deci serverul creează tranzacția o singură dată. Butonul se dezactivează cât timp cererea e în curs. Contribuția la un obiectiv (unde cheia e obligatorie pe server) se comportă la fel.
6. **Sume introduse:** `parseAmount` (aceleași reguli și teste ca web-ul) → `amountMinor` întreg în cerere; monedă = a contului. Câmpurile goale se trimit ca `null`.
7. **Luna** (Acasă, Bugete, Rapoarte) are un selector comun; nu se poate trece de luna curentă și nu mai mult de 60 de luni în urmă (limita API-ului). Luna curentă și „azi” se calculează în fusul orar al gospodăriei (pachetul `timezone`, baza inclusă în aplicație, fără rețea).
8. **Ascunderea sumelor este completă:** orice text care conține o sumă (nu doar widgetul de sumă: și „Depășit cu …”, comparația cu luna trecută, etichetele de accesibilitate) trece prin `displayMoney`. Un test a prins un loc unde sumele rămâneau vizibile.
9. **Statistici:** `dashboard_viewed`, `report_viewed`, `transaction_created`, `goal_contribution_added`, ecranele `transaction_edit`, `budgets`, `goals`; erorile ca `error_shown` cu codurile fixe ale serverului. Nimic financiar în evenimente.
10. **Interfață:** stări distincte de încărcare, eroare (cu reîncercare) și gol; semaforul bugetelor are și text (nu doar culoare); rândurile cu sume folosesc `Wrap`, ca să nu depășească ecranul la fonturi mari (un test a prins două depășiri).

## Ce nu face Faza C

- Nu creează conturi, bugete, obiective, categorii sau etichete (doar le citește; se creează din aplicația web).
- Nu face transferuri între conturi.
- Nu afișează garanțiile SGR și cardul „familie” de pe dashboard: `GET /api/v1/dashboard` nu le întoarce. De clarificat cu operatorul dacă se adaugă un endpoint.
- Nu are grafic cu `fl_chart`: evoluția lunară și categoriile sunt bare simple.
- Verificarea „cifrele sunt identice cu web-ul” pe date reale cere backendul de test.
