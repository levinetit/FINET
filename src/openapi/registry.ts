import { z } from "zod";

import { CATEGORY_KINDS, GOAL_STATUSES, TRANSACTION_SOURCES, TRANSACTION_TYPES } from "@/db/schema";
import { accountCreateSchema, accountUpdateSchema } from "@/modules/accounts/accounts.schema";
import { budgetCreateSchema, budgetUpdateSchema } from "@/modules/budgets/budgets.schema";
import { MAX_TOP_CATEGORIES } from "@/modules/dashboard/dashboard.schema";
import { CSV_DIALECTS } from "@/modules/exports/csv";
import {
  goalContributionSchema,
  goalCreateSchema,
  goalUpdateSchema,
} from "@/modules/goals/goals.schema";
import { tagCreateSchema, tagUpdateSchema } from "@/modules/tags/tags.schema";
import { changePasswordSchema } from "@/modules/auth/password.schema";
import { categoryCreateSchema, categoryUpdateSchema } from "@/modules/categories/categories.schema";
import { profilePatchSchema } from "@/modules/profile/profile.schema";
import {
  TRANSACTION_SORTS,
  transactionCreateSchema,
  transactionUpdateSchema,
} from "@/modules/transactions/transactions.schema";
import { transferCreateSchema, transferUpdateSchema } from "@/modules/transfers/transfers.schema";
import { appEventsBatchSchema, consentsPutSchema } from "@/modules/usage/usage.schema";

import {
  accountSchema,
  budgetSchema,
  budgetStatusSchema,
  categorySchema,
  consentStateSchema,
  dashboardSchema,
  dataOf,
  goalSchema,
  householdDetailSchema,
  householdSummarySchema,
  meSchema,
  moneySchema,
  monthlyReportSchema,
  sessionSchema,
  tagSchema,
  transactionSchema,
  transferSchema,
} from "./schemas";

/**
 * Registrul UNIC al rutelor `/api/v1` (OpenAPI 3.1, ADR 0005): metodă, cale, parametri, corpul
 * cererii, răspunsurile și erorile. `scripts/generate-openapi.ts` scrie din el
 * `docs/openapi.json`; `src/openapi/openapi.test.ts` verifică faptul că fiecare `route.ts` real
 * apare aici și invers. Schemele cererilor sunt CELE ale serviciilor (aceeași validare).
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryParam = Readonly<{
  name: string;
  schema: z.ZodType;
  description: string;
}>;

export type Operation = Readonly<{
  method: HttpMethod;
  /** Calea OpenAPI (`{id}`), aceeași cu directorul rutei (`[id]`). */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  query?: readonly QueryParam[];
  /** Corpul JSON (dacă există). `optional`: se poate trimite fără corp și fără Content-Type. */
  body?: Readonly<{ schema: z.ZodType; optional?: boolean }>;
  /**
   * Răspunsul de succes: status → schemă (`null` = fără corp, 204). `csv`: corpul e `text/csv`
   * (export), fără schemă JSON.
   */
  success: Readonly<{
    status: number;
    schema: z.ZodType | null;
    description: string;
    csv?: boolean;
  }>;
  /** Codurile de eroare posibile, în afară de 401/429/500 (comune). */
  errors: readonly number[];
  /** Acceptă `Idempotency-Key`. */
  idempotent?: boolean;
}>;

const PATH_ID = "{id}";

const accountList = z.strictObject({
  data: z.array(accountSchema),
  totals: z.array(moneySchema).meta({
    description: "Totalul soldurilor conturilor ACTIVE, separat pe monedă (fără conversie).",
  }),
});

const transactionPage = z.strictObject({
  data: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});

const boolParam = z.enum(["true", "false"]);
const intParam = z.string().regex(/^[0-9]{1,16}$/);

const TRANSACTION_FILTERS: readonly QueryParam[] = [
  { name: "q", schema: z.string().max(200), description: "Căutare în descriere și comerciant." },
  { name: "accountId", schema: z.uuid(), description: "Doar tranzacțiile contului." },
  { name: "categoryId", schema: z.uuid(), description: "Doar tranzacțiile categoriei." },
  {
    name: "tagIds",
    schema: z.string().regex(/^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36}){0,9}$/),
    description:
      "Id-uri de etichete separate prin virgulă (1–10, distincte): tranzacțiile care au CEL PUȚIN UNA dintre ele.",
  },
  {
    name: "merchant",
    schema: z.string().max(200),
    description: "Comerciantul conține textul (fără majuscule).",
  },
  { name: "type", schema: z.enum(TRANSACTION_TYPES), description: "Tipul." },
  { name: "source", schema: z.enum(TRANSACTION_SOURCES), description: "Sursa." },
  { name: "dateFrom", schema: z.iso.date(), description: "De la data (inclusiv)." },
  { name: "dateTo", schema: z.iso.date(), description: "Până la data (inclusiv)." },
  { name: "amountMinMinor", schema: intParam, description: "Suma minimă (unități minore)." },
  { name: "amountMaxMinor", schema: intParam, description: "Suma maximă (unități minore)." },
];

const TRANSACTION_QUERY: readonly QueryParam[] = [
  ...TRANSACTION_FILTERS,
  {
    name: "sort",
    schema: z.enum(TRANSACTION_SORTS),
    description: "Sortarea (implicit date_desc).",
  },
  {
    name: "cursor",
    schema: z.string().max(400),
    description: "`nextCursor` din pagina anterioară.",
  },
  { name: "limit", schema: intParam, description: "Rânduri pe pagină (implicit 50, plafon 100)." },
];

const MONTH_PARAM: QueryParam = {
  name: "month",
  schema: z.string().regex(/^[0-9]{4}-[0-9]{2}$/),
  description:
    "Luna `YYYY-MM` (implicit luna curentă în fusul gospodăriei, `Europe/Bucharest`). Acceptat: de la aceeași lună de acum 5 ani (60 de luni în urmă) până la luna curentă; în afara intervalului → 400.",
};

const DIALECT_PARAM: QueryParam = {
  name: "dialect",
  schema: z.enum(CSV_DIALECTS),
  description:
    "`rfc4180` (implicit: virgulă, punct zecimal) sau `ro` (`;`, virgulă zecimală, pentru Excel în română).",
};

const csvSuccess = (description: string) =>
  ({
    status: 200,
    schema: null,
    csv: true,
    description: `${description} UTF-8 cu BOM, CRLF, ghilimele RFC 4180; celulele de text liber care încep cu = + - @ TAB CR primesc un apostrof. Antete: \`Content-Disposition: attachment\` (nume fix), \`Cache-Control: no-store\`, \`X-Content-Type-Options: nosniff\`. Rate limit propriu: 10/min per utilizator.`,
  }) as const;

const pathOf = (base: string, suffix = "") => `${base}/{id}${suffix}`;

const VALIDATION = 400;
const FORBIDDEN = 403; // CSRF (cookie fără Origin corect)
const NOT_FOUND = 404;
const CONFLICT = 409;
const TOO_LARGE = 413;
const MEDIA = 415;
const REUSED = 422; // și `amount_out_of_range` (un sold calculat peste 2^53)

const MUTATION_ERRORS = [VALIDATION, FORBIDDEN, TOO_LARGE, MEDIA] as const;
const IDEMPOTENT_ERRORS = [...MUTATION_ERRORS, CONFLICT, REUSED] as const;

export const OPERATIONS: readonly Operation[] = [
  // --- Contul curent (Faza 1) ----------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/me",
    operationId: "getMe",
    tag: "me",
    summary: "Profilul, preferințele și gospodăria curentă (cu rolul).",
    success: { status: 200, schema: dataOf(meSchema), description: "Profilul." },
    errors: [],
  },
  {
    method: "PATCH",
    path: "/api/v1/me",
    operationId: "patchMe",
    tag: "me",
    summary: "Modifică numele și preferințele.",
    body: { schema: profilePatchSchema },
    success: { status: 200, schema: dataOf(meSchema), description: "Profilul actualizat." },
    errors: [...MUTATION_ERRORS],
  },
  {
    method: "POST",
    path: "/api/v1/me/password",
    operationId: "changePassword",
    tag: "me",
    summary: "Schimbă parola (cere parola curentă; revocă celelalte sesiuni).",
    body: { schema: changePasswordSchema },
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ revokedSessions: z.number().int() })),
      description: "Parola a fost schimbată.",
    },
    errors: [...MUTATION_ERRORS],
  },
  {
    method: "GET",
    path: "/api/v1/me/sessions",
    operationId: "listSessions",
    tag: "me",
    summary: "Sesiunile active (fără tokenuri; IP-ul trunchiat).",
    success: { status: 200, schema: dataOf(z.array(sessionSchema)), description: "Sesiunile." },
    errors: [],
  },
  {
    method: "DELETE",
    path: `/api/v1/me/sessions/${PATH_ID}`,
    operationId: "revokeSession",
    tag: "me",
    summary: "Revocă o sesiune proprie.",
    success: { status: 204, schema: null, description: "Revocată." },
    errors: [FORBIDDEN, NOT_FOUND],
  },
  {
    method: "POST",
    path: "/api/v1/me/sessions/revoke-others",
    operationId: "revokeOtherSessions",
    tag: "me",
    summary: "Revocă toate celelalte sesiuni.",
    body: { schema: z.strictObject({}), optional: true },
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ revoked: z.number().int() })),
      description: "Numărul de sesiuni revocate.",
    },
    errors: [FORBIDDEN, MEDIA, TOO_LARGE],
  },
  {
    method: "GET",
    path: "/api/v1/me/consents",
    operationId: "getConsents",
    tag: "me",
    summary: "Consimțămintele (statistici de utilizare, AI extern).",
    success: {
      status: 200,
      schema: dataOf(z.array(consentStateSchema)),
      description: "Starea fiecărui tip.",
    },
    errors: [],
  },
  {
    method: "PUT",
    path: "/api/v1/me/consents",
    operationId: "putConsents",
    tag: "me",
    summary: "Acordă (`true`) sau revocă (`false`) consimțăminte; schimbările se auditează.",
    body: { schema: consentsPutSchema },
    success: {
      status: 200,
      schema: dataOf(z.array(consentStateSchema)),
      description: "Starea nouă.",
    },
    errors: [...MUTATION_ERRORS],
  },
  // --- Statistici de utilizare (6.5) ---------------------------------------------------------
  {
    method: "POST",
    path: "/api/v1/app/events",
    operationId: "postAppEvents",
    tag: "usage",
    summary: "Evenimente de utilizare (listă fixă, cel mult 20 pe lot).",
    description:
      "Fiecare eveniment are DOAR `name`, `screen?`, `errorCode?`, `occurredAt` (cel mult 30 de zile în urmă, 5 minute în viitor). Orice alt câmp respinge lotul (400, mesaj fix). Fără consimțământul `usageStats` activ, nimic nu se stochează (tot 204).",
    body: { schema: appEventsBatchSchema },
    success: { status: 204, schema: null, description: "Primit." },
    errors: [...MUTATION_ERRORS],
  },
  // --- Gospodăriile --------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/households",
    operationId: "listHouseholds",
    tag: "households",
    summary: "Gospodăriile mele, cu rolul; `current` = cea în care lucrează API-ul.",
    success: {
      status: 200,
      schema: dataOf(z.array(householdSummarySchema)),
      description: "Gospodăriile.",
    },
    errors: [VALIDATION],
  },
  {
    method: "GET",
    path: `/api/v1/households/${PATH_ID}`,
    operationId: "getHousehold",
    tag: "households",
    summary: "O gospodărie a mea, cu membrii (id, nume, rol; fără emailuri).",
    success: { status: 200, schema: dataOf(householdDetailSchema), description: "Gospodăria." },
    errors: [NOT_FOUND],
  },
  // --- Conturile -----------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/accounts",
    operationId: "listAccounts",
    tag: "accounts",
    summary: "Conturile gospodăriei curente, cu sold calculat și totaluri pe monedă.",
    description: "Lista nu e paginată (numărul de conturi e mic).",
    query: [
      { name: "includeArchived", schema: boolParam, description: "Include conturile arhivate." },
    ],
    success: { status: 200, schema: accountList, description: "Conturile." },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "POST",
    path: "/api/v1/accounts",
    operationId: "createAccount",
    tag: "accounts",
    summary: "Creează un cont.",
    body: { schema: accountCreateSchema },
    success: { status: 201, schema: dataOf(accountSchema), description: "Contul creat." },
    errors: [...IDEMPOTENT_ERRORS],
    idempotent: true,
  },
  {
    method: "GET",
    path: `/api/v1/accounts/${PATH_ID}`,
    operationId: "getAccount",
    tag: "accounts",
    summary: "Un cont, cu soldul calculat.",
    success: { status: 200, schema: dataOf(accountSchema), description: "Contul." },
    errors: [NOT_FOUND, REUSED],
  },
  {
    method: "PATCH",
    path: `/api/v1/accounts/${PATH_ID}`,
    operationId: "patchAccount",
    tag: "accounts",
    summary: "Modifică un cont (moneda doar fără tranzacții).",
    body: { schema: accountUpdateSchema },
    success: { status: 200, schema: dataOf(accountSchema), description: "Contul actualizat." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT, REUSED],
  },
  {
    method: "DELETE",
    path: `/api/v1/accounts/${PATH_ID}`,
    operationId: "deleteAccount",
    tag: "accounts",
    summary: "Șterge un cont GOL; cu tranzacții → 409 `account_not_empty` (arhivează-l).",
    success: { status: 204, schema: null, description: "Șters." },
    errors: [FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA],
  },
  {
    method: "POST",
    path: `/api/v1/accounts/${PATH_ID}/archive`,
    operationId: "archiveAccount",
    tag: "accounts",
    summary: "Arhivează contul (rămâne în istoric, nu mai primește tranzacții).",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(accountSchema), description: "Contul." },
    errors: [FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA, TOO_LARGE, REUSED],
  },
  {
    method: "POST",
    path: `/api/v1/accounts/${PATH_ID}/unarchive`,
    operationId: "unarchiveAccount",
    tag: "accounts",
    summary: "Reactivează un cont arhivat.",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(accountSchema), description: "Contul." },
    errors: [FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA, TOO_LARGE, REUSED],
  },
  // --- Categoriile ---------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/categories",
    operationId: "listCategories",
    tag: "categories",
    summary: "Categoriile de sistem și ale gospodăriei (implicit și cele ascunse).",
    query: [
      {
        name: "kind",
        schema: z.enum(CATEGORY_KINDS),
        description: "Doar venituri sau cheltuieli.",
      },
      { name: "includeHidden", schema: boolParam, description: "`false` = fără cele ascunse." },
    ],
    success: { status: 200, schema: dataOf(z.array(categorySchema)), description: "Categoriile." },
    errors: [VALIDATION],
  },
  {
    method: "POST",
    path: "/api/v1/categories",
    operationId: "createCategory",
    tag: "categories",
    summary: "Creează o categorie personalizată.",
    body: { schema: categoryCreateSchema },
    success: { status: 201, schema: dataOf(categorySchema), description: "Categoria creată." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: `/api/v1/categories/${PATH_ID}`,
    operationId: "getCategory",
    tag: "categories",
    summary: "O categorie.",
    success: { status: 200, schema: dataOf(categorySchema), description: "Categoria." },
    errors: [NOT_FOUND],
  },
  {
    method: "PATCH",
    path: `/api/v1/categories/${PATH_ID}`,
    operationId: "patchCategory",
    tag: "categories",
    summary: "Modifică o categorie (cele de sistem: doar `hidden`).",
    body: { schema: categoryUpdateSchema },
    success: { status: 200, schema: dataOf(categorySchema), description: "Categoria." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: `/api/v1/categories/${PATH_ID}`,
    operationId: "deleteCategory",
    tag: "categories",
    summary: "Șterge o categorie personalizată; dacă e folosită, cere `reassignToId`.",
    query: [
      {
        name: "reassignToId",
        schema: z.uuid(),
        description: "Categoria (de același tip) care preia tranzacțiile.",
      },
    ],
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ reassigned: z.number().int() })),
      description: "Câte tranzacții au fost mutate.",
    },
    errors: [VALIDATION, FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA],
  },
  {
    method: "POST",
    path: `/api/v1/categories/${PATH_ID}/hide`,
    operationId: "hideCategory",
    tag: "categories",
    summary: "Ascunde categoria (per gospodărie, și pentru cele de sistem).",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(categorySchema), description: "Categoria." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA, TOO_LARGE],
  },
  {
    method: "POST",
    path: `/api/v1/categories/${PATH_ID}/unhide`,
    operationId: "unhideCategory",
    tag: "categories",
    summary: "Afișează din nou categoria.",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(categorySchema), description: "Categoria." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA, TOO_LARGE],
  },
  // --- Tranzacțiile --------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/transactions",
    operationId: "listTransactions",
    tag: "transactions",
    summary: "Tranzacțiile: filtre, căutare, sortare și paginare cu cursor.",
    query: TRANSACTION_QUERY,
    success: { status: 200, schema: transactionPage, description: "O pagină." },
    errors: [VALIDATION],
  },
  {
    method: "POST",
    path: "/api/v1/transactions",
    operationId: "createTransaction",
    tag: "transactions",
    summary: "Creează un venit sau o cheltuială (`amountMinor` întreg SAU `amount` text).",
    body: { schema: transactionCreateSchema },
    success: { status: 201, schema: dataOf(transactionSchema), description: "Tranzacția creată." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: `/api/v1/transactions/${PATH_ID}`,
    operationId: "getTransaction",
    tag: "transactions",
    summary: "O tranzacție.",
    success: { status: 200, schema: dataOf(transactionSchema), description: "Tranzacția." },
    errors: [NOT_FOUND],
  },
  {
    method: "PATCH",
    path: `/api/v1/transactions/${PATH_ID}`,
    operationId: "patchTransaction",
    tag: "transactions",
    summary: "Modifică o tranzacție (nu un rând de transfer).",
    body: { schema: transactionUpdateSchema },
    success: { status: 200, schema: dataOf(transactionSchema), description: "Tranzacția." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: `/api/v1/transactions/${PATH_ID}`,
    operationId: "deleteTransaction",
    tag: "transactions",
    summary: "Șterge o tranzacție (nu un rând de transfer).",
    success: { status: 204, schema: null, description: "Ștearsă." },
    errors: [FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA],
  },
  // --- Transferurile -------------------------------------------------------------------------
  {
    method: "POST",
    path: "/api/v1/transfers",
    operationId: "createTransfer",
    tag: "transfers",
    summary: "Transfer atomic între două conturi (monede diferite: ambele sume explicit).",
    body: { schema: transferCreateSchema },
    success: { status: 201, schema: dataOf(transferSchema), description: "Transferul creat." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: "/api/v1/transfers/{groupId}",
    operationId: "getTransfer",
    tag: "transfers",
    summary: "Un transfer (după `transfer_group_id`).",
    success: { status: 200, schema: dataOf(transferSchema), description: "Transferul." },
    errors: [NOT_FOUND],
  },
  {
    method: "PATCH",
    path: "/api/v1/transfers/{groupId}",
    operationId: "patchTransfer",
    tag: "transfers",
    summary: "Modifică suma, data sau textele unui transfer (ambele rânduri).",
    body: { schema: transferUpdateSchema },
    success: { status: 200, schema: dataOf(transferSchema), description: "Transferul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: "/api/v1/transfers/{groupId}",
    operationId: "deleteTransfer",
    tag: "transfers",
    summary: "Șterge ambele rânduri ale transferului.",
    success: { status: 204, schema: null, description: "Șters." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA],
  },
  // --- Etichetele (Faza 3) ------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/tags",
    operationId: "listTags",
    tag: "tags",
    summary: "Etichetele de sistem și ale gospodăriei, cu numărul de utilizări.",
    query: [
      { name: "includeHidden", schema: boolParam, description: "Include și etichetele ascunse." },
    ],
    success: { status: 200, schema: dataOf(z.array(tagSchema)), description: "Etichetele." },
    errors: [VALIDATION],
  },
  {
    method: "POST",
    path: "/api/v1/tags",
    operationId: "createTag",
    tag: "tags",
    summary: "Creează o etichetă (nume unic fără majuscule, inclusiv față de cele de sistem).",
    body: { schema: tagCreateSchema },
    success: { status: 201, schema: dataOf(tagSchema), description: "Eticheta creată." },
    errors: [...IDEMPOTENT_ERRORS],
    idempotent: true,
  },
  {
    method: "GET",
    path: pathOf("/api/v1/tags"),
    operationId: "getTag",
    tag: "tags",
    summary: "O etichetă.",
    success: { status: 200, schema: dataOf(tagSchema), description: "Eticheta." },
    errors: [NOT_FOUND],
  },
  {
    method: "PATCH",
    path: pathOf("/api/v1/tags"),
    operationId: "patchTag",
    tag: "tags",
    summary: "Modifică o etichetă (cele de sistem: doar `hidden`, altfel 409 `system_tag`).",
    body: { schema: tagUpdateSchema },
    success: { status: 200, schema: dataOf(tagSchema), description: "Eticheta." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/tags"),
    operationId: "deleteTag",
    tag: "tags",
    summary: "Șterge o etichetă proprie și legăturile ei; una de sistem → 409 (se poate ascunde).",
    success: { status: 204, schema: null, description: "Ștearsă." },
    errors: [FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA],
  },
  // --- Bugetele ------------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/budgets",
    operationId: "listBudgets",
    tag: "budgets",
    summary: "Bugetele vizibile (ale gospodăriei și cele personale proprii).",
    query: [
      { name: "includeArchived", schema: boolParam, description: "Include bugetele arhivate." },
    ],
    success: { status: 200, schema: dataOf(z.array(budgetSchema)), description: "Bugetele." },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "POST",
    path: "/api/v1/budgets",
    operationId: "createBudget",
    tag: "budgets",
    summary: "Creează un buget lunar (general sau pe o categorie de cheltuieli).",
    description:
      "Categoria, moneda și domeniul nu se mai pot schimba. `scope: personal` = al utilizatorului curent, vizibil doar lui. Un buget activ identic → 409 `budget_exists`.",
    body: { schema: budgetCreateSchema },
    success: { status: 201, schema: dataOf(budgetSchema), description: "Bugetul creat." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: "/api/v1/budgets/status",
    operationId: "getBudgetStatus",
    tag: "budgets",
    summary: "Starea bugetelor active într-o lună (semafor) și avertizările.",
    description:
      "`alerts` = bugetele galbene și roșii ale lunii (roșii întâi). Cheltuit = cheltuielile lunii în moneda bugetului (subcategoriile incluse; transferurile și veniturile nu contează).",
    query: [MONTH_PARAM],
    success: {
      status: 200,
      schema: z.strictObject({
        month: z.string(),
        data: z.array(budgetStatusSchema),
        alerts: z.array(z.strictObject({ budgetId: z.uuid(), status: z.enum(["yellow", "red"]) })),
      }),
      description: "Stările și avertizările.",
    },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "GET",
    path: pathOf("/api/v1/budgets"),
    operationId: "getBudget",
    tag: "budgets",
    summary: "Un buget.",
    success: { status: 200, schema: dataOf(budgetSchema), description: "Bugetul." },
    errors: [NOT_FOUND],
  },
  {
    method: "PATCH",
    path: pathOf("/api/v1/budgets"),
    operationId: "patchBudget",
    tag: "budgets",
    summary: "Modifică suma, pragul de avertizare sau arhivarea.",
    body: { schema: budgetUpdateSchema },
    success: { status: 200, schema: dataOf(budgetSchema), description: "Bugetul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/budgets"),
    operationId: "deleteBudget",
    tag: "budgets",
    summary: "Șterge definitiv un buget (confirmarea e a interfeței; auditat fără sume).",
    success: { status: 204, schema: null, description: "Șters." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA],
  },
  // --- Obiectivele ---------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/goals",
    operationId: "listGoals",
    tag: "goals",
    summary: "Obiectivele de economisire, cu progresul.",
    query: [{ name: "status", schema: z.enum(GOAL_STATUSES), description: "Doar o stare." }],
    success: { status: 200, schema: dataOf(z.array(goalSchema)), description: "Obiectivele." },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "POST",
    path: "/api/v1/goals",
    operationId: "createGoal",
    tag: "goals",
    summary: "Creează un obiectiv (cont opțional, aceeași monedă).",
    body: { schema: goalCreateSchema },
    success: { status: 201, schema: dataOf(goalSchema), description: "Obiectivul creat." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: pathOf("/api/v1/goals"),
    operationId: "getGoal",
    tag: "goals",
    summary: "Un obiectiv.",
    success: { status: 200, schema: dataOf(goalSchema), description: "Obiectivul." },
    errors: [NOT_FOUND, REUSED],
  },
  {
    method: "PATCH",
    path: pathOf("/api/v1/goals"),
    operationId: "patchGoal",
    tag: "goals",
    summary: "Modifică un obiectiv; `status`: `abandoned` (renunțare) sau `active` (reluare).",
    description: "`achieved` e calculat (economisit ≥ țintă), nu se trimite.",
    body: { schema: goalUpdateSchema },
    success: { status: 200, schema: dataOf(goalSchema), description: "Obiectivul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/goals"),
    operationId: "deleteGoal",
    tag: "goals",
    summary: "Șterge definitiv un obiectiv (confirmarea e a interfeței; auditat fără sume).",
    success: { status: 204, schema: null, description: "Șters." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA],
  },
  {
    method: "POST",
    path: pathOf("/api/v1/goals", "/contributions"),
    operationId: "contributeGoal",
    tag: "goals",
    summary: "O contribuție (`add`) sau o retragere (`withdraw`); `Idempotency-Key` OBLIGATORIU.",
    description:
      "Fără cheie → 400 (o reîncercare fără cheie ar dubla suma). Economisitul nu scade sub 0 (409 `goal_saved_negative`); un obiectiv abandonat refuză contribuțiile (409 `goal_abandoned`). Starea `achieved` se recalculează (reversibil).",
    body: { schema: goalContributionSchema },
    success: { status: 200, schema: dataOf(goalSchema), description: "Obiectivul actualizat." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "POST",
    path: pathOf("/api/v1/goals", "/abandon"),
    operationId: "abandonGoal",
    tag: "goals",
    summary: "Renunță la obiectiv (reluarea: `PATCH` cu `status: active`).",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(goalSchema), description: "Obiectivul." },
    errors: [FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA, TOO_LARGE],
  },
  // --- Dashboard și raportul lunar -----------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/dashboard",
    operationId: "getDashboard",
    tag: "reports",
    summary: "Dashboard-ul lunar, separat pe monedă (fără conversie).",
    description:
      "Totaluri (transferurile excluse), comparația cu luna anterioară (procent `null` când luna anterioară e 0), cheltuielile pe categorii-părinte (top N + „Altele”), ultimele 12 luni, trendul zilnic, onboarding.",
    query: [
      MONTH_PARAM,
      {
        name: "topCategories",
        schema: intParam,
        description: `Câte categorii în top (1–${MAX_TOP_CATEGORIES}, implicit 5).`,
      },
    ],
    success: { status: 200, schema: dataOf(dashboardSchema), description: "Dashboard-ul." },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/reports/monthly",
    operationId: "getMonthlyReport",
    tag: "reports",
    summary:
      "Raportul lunar (structura de date): totaluri, categorii, comercianți, bugete, obiective.",
    query: [MONTH_PARAM],
    success: { status: 200, schema: dataOf(monthlyReportSchema), description: "Raportul." },
    errors: [VALIDATION, REUSED],
  },
  // --- Exporturile CSV -----------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/exports/transactions.csv",
    operationId: "exportTransactionsCsv",
    tag: "exports",
    summary: "Exportul CSV al tranzacțiilor (filtrele listei), în flux.",
    description:
      "Aceleași filtre ca `GET /transactions`, fără `sort`, `cursor`, `limit` (ordine cronologică). Cel mult 50.000 de rânduri; peste → 409 `export_too_large` (JSON, fără conținut parțial).",
    query: [...TRANSACTION_FILTERS, DIALECT_PARAM],
    success: csvSuccess("Fișierul `finet-tranzactii.csv`."),
    errors: [VALIDATION, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/exports/goals.csv",
    operationId: "exportGoalsCsv",
    tag: "exports",
    summary: "Exportul CSV al obiectivelor (toate stările).",
    query: [DIALECT_PARAM],
    success: csvSuccess("Fișierul `finet-obiective.csv`."),
    errors: [VALIDATION, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/exports/budgets.csv",
    operationId: "exportBudgetsCsv",
    tag: "exports",
    summary: "Exportul CSV al bugetelor active vizibile, cu starea într-o lună.",
    query: [MONTH_PARAM, DIALECT_PARAM],
    success: csvSuccess("Fișierul `finet-bugete.csv`."),
    errors: [VALIDATION, REUSED],
  },
];

/** Operația după metodă și cale (pentru testele de contract). */
export function operation(method: HttpMethod, path: string): Operation {
  const op = OPERATIONS.find((o) => o.method === method && o.path === path);
  if (!op) throw new Error(`operație nedocumentată: ${method} ${path}`);
  return op;
}
