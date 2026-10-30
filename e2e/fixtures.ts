import {
  type BrowserContext,
  type Page,
  type Request,
  expect,
  test as base,
} from "@playwright/test";

/**
 * Datele testelor E2E de autentificare. Utilizatorii se creează ÎNAINTE de rulare, cu CLI-ul
 * admin (parola din stdin), câte douăzeci și patru pentru fiecare mod, ca scenariile să nu se încurce (fără IP
 * de încredere în dezvoltare, rate limiting-ul e pe email; mutațiile API au 120/min per
 * utilizator, de aceea seed-ul de paginare are utilizatorul lui):
 *
 *   for u in main parola sesiuni ledger ledger2 seed planning planning2 regresii recurring recurring2 receipts receipts2 family family2 family3 pwa pwa2 gdpr gdpr2 a11y statements statements2 statements3 shopping shopping2 insights insights2 ask; do
 *     printf '%s\n' "$E2E_PASSWORD" | FINET_ROLE=admin DATABASE_URL=<finet_app> \
 *       node dist/tools/admin.mjs create-user --email "e2e-$u-<mod>@finet.test" \
 *       --name "E2E $u" --password-stdin
 *   done
 *
 * `E2E_PASSWORD` e doar pentru baza de test (job-ul `e2e` din CI); nu e un secret real.
 */

export const MODE = process.env.E2E_APP_MODE === "saas" ? "saas" : "personal";

export function password(): string {
  const value = process.env.E2E_PASSWORD;
  if (!value || value.length < 10) {
    throw new Error("E2E_PASSWORD lipsește (minimum 10 caractere): vezi e2e/fixtures.ts");
  }
  return value;
}

/**
 * Utilizatorii E2E: `auth` (main, parola, sesiuni), `ledger` (ledger, ledger2, seed) și
 * `planning` (planning, planning2; Faza 3: exporturile au 10/min per utilizator) și `regressions`
 * (regresii; Faza 4), `recurring` (recurring, recurring2; Faza 5) și `receipts` (receipts,
 * receipts2; Faza 6: al doilea fără consimțământ AI, și pentru izolare) și `family` (family,
 * family2, family3; Faza 8: owner, membru prin invitație, utilizator din afară) și `pwa` (pwa,
 * pwa2; Faza 9: scanarea offline, coada locală, deconectarea), `gdpr` (gdpr, gdpr2; F9-B: exportul
 * și ștergerea contului — `gdpr2` nu mai există după test), `a11y` (F9-B: auditul axe) și `statements`
 * (statements, statements2, statements3; Faza 7: proprietarul, o altă gospodărie, un membru) și
 * `shopping` (shopping, shopping2; F10-A: listele de cumpărături, două gospodării pentru izolare).
 * `insights` (insights, insights2; F10-B: rapoarte inteligente, izolarea) și
 * `ask` (ask; F10-C: „Întreabă FINET” și rezumatul lunii).
 */
export const USER_KINDS = [
  "main",
  "parola",
  "sesiuni",
  "ledger",
  "ledger2",
  "seed",
  "planning",
  "planning2",
  "regresii",
  "recurring",
  "recurring2",
  "receipts",
  "receipts2",
  "family",
  "family2",
  "family3",
  "pwa",
  "pwa2",
  "gdpr",
  "gdpr2",
  "a11y",
  "statements",
  "statements2",
  "statements3",
  "shopping",
  "shopping2",
  "insights",
  "insights2",
  "ask",
] as const;
export type UserKind = (typeof USER_KINDS)[number];

export function userEmail(kind: UserKind): string {
  return `e2e-${kind}-${MODE}@finet.test`;
}

export async function login(page: Page, email: string, pass: string, next?: string): Promise<void> {
  await page.goto(next === undefined ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "Intră în cont" }).click();
}

export async function loginOk(page: Page, email: string, pass: string): Promise<void> {
  await login(page, email, pass);
  await expect(page).toHaveURL(/\/dashboard$/);
}

/**
 * Cererile RSC în zbor la sfârșitul unui test (`router.refresh()`, navigări client; adresa are
 * `_rsc=`). Un test care se termină imediat după o acțiune (de exemplu „Salvează” pe /profile, care
 * face `router.refresh()`) lasă o astfel de cerere neterminată: la închiderea contextului browserul o
 * ABANDONEAZĂ în timp ce serverul încă scrie răspunsul, iar `next dev` loghează o eroare React
 * Flight („The destination stream errored while writing data.”, digest 2268694629). Nu e o eroare a
 * aplicației (producția doar închide conexiunea), dar arată ca una în jurnalul CI.
 *
 * Reparația e în SINCRONIZAREA testelor, nu în filtrarea jurnalului: înainte să se închidă
 * contextele unui test, se așteaptă (cel mult `SETTLE_TIMEOUT_MS`) terminarea cererilor RSC pornite.
 * Fluxul SSE `/api/v1/events` nu e RSC și rămâne ca atare.
 */
const RSC_REQUEST = /[?&]_rsc=/;
const SETTLE_TIMEOUT_MS = 10_000;

export function trackRsc(context: BrowserContext, pending: Set<Request>): void {
  const watch = (page: Page) => {
    page.on("request", (request) => {
      if (RSC_REQUEST.test(request.url())) pending.add(request);
    });
    const done = (request: Request) => void pending.delete(request);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
}

/** Așteaptă (fără să pice testul) terminarea cererilor RSC urmărite. */
export async function settleRsc(
  pending: ReadonlySet<Request>,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * `test` al suitei: ca cel din Playwright, plus așteptarea cererilor RSC în zbor, pe TOATE
 * contextele testului, înainte de închidere:
 * - contextul implicit (fixture-ul `page`/`context`), prin suprascrierea lui `context`: se
 *   instanțiază doar când testul îl cere (testele doar cu `request` nu pornesc niciun context);
 * - contextele create în test cu `browser.newContext(...)`, urmărite cât durează testul.
 */
// Al doilea parametru se numește `provide`, nu `use`: regula react-hooks confundă `use` cu un hook React.
export const test = base.extend<{ rscPending: Set<Request>; settleRscAtEnd: void }>({
  rscPending: async ({}, provide) => {
    await provide(new Set<Request>());
  },
  context: async ({ context, rscPending }, provide) => {
    trackRsc(context, rscPending);
    await provide(context);
    await settleRsc(rscPending);
  },
  settleRscAtEnd: [
    async ({ browser, rscPending }, provide) => {
      const original = browser.newContext.bind(browser);
      browser.newContext = (async (...args: Parameters<typeof original>) => {
        const created = await original(...args);
        trackRsc(created, rscPending);
        return created;
      }) as typeof browser.newContext;
      // `provide` (callback-ul fixture-ului) nu aruncă la un test eșuat: teardown-ul de mai jos rulează oricum.
      await provide();
      browser.newContext = original;
      await settleRsc(rscPending);
    },
    { auto: true },
  ],
});
