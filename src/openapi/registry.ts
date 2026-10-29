import { z } from "zod";

import {
  CATEGORY_KINDS,
  GOAL_STATUSES,
  RECURRING_STATUSES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
} from "@/db/schema";
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
import { recurringCreateSchema, recurringUpdateSchema } from "@/modules/recurring/recurring.schema";
import {
  TRANSACTION_SORTS,
  transactionCreateSchema,
  transactionUpdateSchema,
} from "@/modules/transactions/transactions.schema";
import { transferCreateSchema, transferUpdateSchema } from "@/modules/transfers/transfers.schema";
import { appEventsBatchSchema, consentsPutSchema } from "@/modules/usage/usage.schema";
import { DOCUMENT_STATUSES, RECEIPT_STATUSES } from "@/db/schema";
import { receiptConfirmSchema, receiptPatchSchema } from "@/modules/receipts/receipts.schema";
import {
  activeHouseholdSchema,
  inviteAcceptSchema,
  inviteCreateSchema,
  roleChangeSchema,
  settlementCreateSchema,
  splitSetSchema,
} from "@/modules/family/family.schema";

import {
  acceptInviteResultSchema,
  balancesSchema,
  createdInviteSchema,
  familyMemberSchema,
  inviteSchema,
  memberExitResultSchema,
  settlementSchema,
  splitSchema,
  accountSchema,
  aiUsageSchema,
  budgetSchema,
  documentSchema,
  receiptConfirmResultSchema,
  receiptDetailSchema,
  receiptReprocessResultSchema,
  receiptSchema,
  uploadResultSchema,
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
  recurringCountsSchema,
  recurringGenerateResultSchema,
  recurringRuleSchema,
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
  /** Corpul `multipart/form-data` (încărcarea documentelor, Faza 6): câmpuri text + fișiere. */
  multipart?: Readonly<{ fields: Readonly<Record<string, string>>; description: string }>;
  /**
   * Răspunsul de succes: status → schemă (`null` = fără corp, 204). `csv`: corpul e `text/csv`
   * (export), fără schemă JSON.
   */
  success: Readonly<{
    status: number;
    schema: z.ZodType | null;
    description: string;
    csv?: boolean;
    /** Corpul e binar (fișierul unui document), cu tipul detectat; fără schemă JSON. */
    binary?: readonly string[];
    /** Alt status de succes cu aceeași schemă (încărcarea: 200 când toate fișierele erau deja). */
    alsoStatus?: number;
    /** Corpul e un flux `text/event-stream` (Server-Sent Events, Faza 8). */
    sse?: boolean;
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
      "Id-uri de etichete separate prin virgulă (1–10, distincte): tranzacțiile care au CEL PUȚIN UNA dintre ele (sau TOATE, cu `tagMatch=all`).",
  },
  {
    name: "tagMatch",
    schema: z.enum(["any", "all"]),
    description:
      "Potrivirea etichetelor: `any` (implicit, oricare) sau `all` (toate). Doar împreună cu `tagIds` (altfel 400 `validation_failed`).",
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
const FORBIDDEN = 403; // CSRF (cookie fără Origin corect; la exporturi: `Sec-Fetch-Site`)
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
    summary:
      "Șterge o categorie personalizată (în gospodăriile cu mai mulți membri o ascunde); dacă e folosită, cere `reassignToId`.",
    query: [
      {
        name: "reassignToId",
        schema: z.uuid(),
        description: "Categoria (de același tip) care preia tranzacțiile.",
      },
    ],
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ reassigned: z.number().int(), hidden: z.boolean() })),
      description:
        "Câte tranzacții au fost mutate; `hidden: true` = categoria a fost ascunsă, nu ștearsă (gospodărie cu mai mulți membri, ADR 0016).",
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
  // --- Documentele și bonurile (Faza 6) ------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/documents",
    operationId: "listDocuments",
    tag: "documents",
    summary: "Documentele gospodăriei (cele mai noi întâi), cu starea și bonul extras.",
    query: [
      { name: "status", schema: z.enum(DOCUMENT_STATUSES), description: "Doar o stare." },
      {
        name: "since",
        schema: z.iso.datetime(),
        description: "Doar documentele încărcate după acest moment (ISO 8601 UTC).",
      },
      { name: "limit", schema: intParam, description: "Câte (implicit 50, plafon 100)." },
    ],
    success: { status: 200, schema: dataOf(z.array(documentSchema)), description: "Documentele." },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "POST",
    path: "/api/v1/documents",
    operationId: "uploadDocuments",
    tag: "documents",
    summary: "Încarcă 1–4 bonuri (poze JPEG/PNG/WebP sau PDF), opțional ca bon lung.",
    description:
      "`multipart/form-data`, citit în flux. Tipul se detectează după conținut (nu după extensie sau `Content-Type`); HEIC/HEIF → 415 `heic_unsupported`; SVG/HTML/alte tipuri → 415. Plafoane: `MAX_UPLOAD_MB` pe fișier (implicit 10), ≤ 4 fișiere, pixeli, pagini PDF. Același fișier (SHA-256) → documentul existent (`duplicate: true`, 200), fără limită. Limita zilnică (409 `daily_document_limit`), cota (409 `storage_quota_exceeded`), bon lung cu o poză deja încărcată (409 `long_receipt_duplicate`), extrase (400, Faza 7). Starea inițială: `queued` cu consimțământul `externalAi`, altfel `awaiting_consent`. Ruta e exclusă din proxy-ul Next (ca fluxul să nu fie copiat în memorie), cu aceeași verificare Cloudflare Access. Fără `Idempotency-Key`: idempotentă prin SHA-256. Limită proprie de cereri (429).",
    multipart: {
      description: "Câmpurile text înaintea fișierelor.",
      fields: {
        kind: "`receipt` (implicit). `statement` → 400 (extrasele vin în Faza 7).",
        longReceipt: "`true` = bon lung în 2–4 poze, în ordine de sus în jos.",
        files: "1–4 fișiere.",
      },
    },
    success: {
      status: 201,
      alsoStatus: 200,
      schema: dataOf(uploadResultSchema),
      description: "Documentele create (200: toate fișierele existau deja, `duplicate: true`).",
    },
    errors: [VALIDATION, FORBIDDEN, CONFLICT, TOO_LARGE, MEDIA, 422],
  },
  {
    method: "GET",
    path: pathOf("/api/v1/documents"),
    operationId: "getDocument",
    tag: "documents",
    summary: "Starea unui document (cod de eroare stabil, bonul extras).",
    success: { status: 200, schema: dataOf(documentSchema), description: "Documentul." },
    errors: [VALIDATION, NOT_FOUND],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/documents"),
    operationId: "deleteDocument",
    tag: "documents",
    summary: "Șterge documentul și fișierul (bonul extras dispare; tranzacția creată rămâne).",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 204, schema: null, description: "Șters." },
    errors: [...MUTATION_ERRORS, NOT_FOUND],
  },
  {
    method: "GET",
    path: pathOf("/api/v1/documents", "/file"),
    operationId: "getDocumentFile",
    tag: "documents",
    summary: "Fișierul original, în flux, doar pentru membrii gospodăriei.",
    description:
      "Tipul detectat după conținut, `Content-Disposition: attachment` cu nume generat de server, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. Fișier șters la retenție → 404.",
    success: {
      status: 200,
      schema: null,
      binary: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
      description: "Fișierul.",
    },
    errors: [VALIDATION, NOT_FOUND],
  },
  {
    method: "GET",
    path: "/api/v1/ai/usage",
    operationId: "getAiUsage",
    tag: "documents",
    summary: "Contorul zilei: „X din Y documente azi” (fără costuri).",
    success: { status: 200, schema: dataOf(aiUsageSchema), description: "Contorul." },
    errors: [VALIDATION],
  },
  {
    method: "GET",
    path: "/api/v1/receipts",
    operationId: "listReceipts",
    tag: "receipts",
    summary: "Bonurile gospodăriei (cele mai noi întâi), cu filtre și căutare.",
    query: [
      { name: "status", schema: z.enum(RECEIPT_STATUSES), description: "Doar o stare." },
      {
        name: "q",
        schema: z.string().max(100),
        description:
          "Magazin, produs (nume brut sau normalizat) sau sumă (`45,90` / `45.90`: totalul sau o linie).",
      },
      {
        name: "merchant",
        schema: z.string().max(100),
        description: "Comerciantul conține textul.",
      },
      { name: "dateFrom", schema: z.iso.date(), description: "Data bonului ≥ (inclusiv)." },
      { name: "dateTo", schema: z.iso.date(), description: "Data bonului ≤ (inclusiv)." },
      { name: "amountMinMinor", schema: intParam, description: "Totalul minim (unități minore)." },
      { name: "amountMaxMinor", schema: intParam, description: "Totalul maxim (unități minore)." },
      { name: "categoryId", schema: z.uuid(), description: "Bonurile cu o linie în categorie." },
      {
        name: "tagId",
        schema: z.uuid(),
        description: "Bonurile a căror tranzacție are eticheta (liniile nu au etichete).",
      },
      { name: "cursor", schema: z.string().max(400), description: "`nextCursor` anterior." },
      { name: "limit", schema: intParam, description: "Rânduri (implicit 50, plafon 100)." },
    ],
    success: {
      status: 200,
      schema: z.strictObject({ data: z.array(receiptSchema), nextCursor: z.string().nullable() }),
      description: "Pagina.",
    },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "GET",
    path: pathOf("/api/v1/receipts"),
    operationId: "getReceipt",
    tag: "receipts",
    summary:
      "Bonul cu liniile, problemele (coduri stabile), furnizorul AI și motivul fallback-ului.",
    success: { status: 200, schema: dataOf(receiptDetailSchema), description: "Bonul." },
    errors: [VALIDATION, NOT_FOUND, REUSED],
  },
  {
    method: "PATCH",
    path: pathOf("/api/v1/receipts"),
    operationId: "patchReceipt",
    tag: "receipts",
    summary: "Corectează câmpurile și liniile bonului (până la confirmare).",
    description:
      "Liniile se ÎNLOCUIESC integral (ordinea = poziția; `id` păstrează o linie existentă). Sumele doar ca întregi `…Minor`. Verificările din cod și scorul se recalculează; cheia de deduplicare la fel (coliziune → bonul devine „posibil duplicat”). O categorie aleasă pe o linie de produs actualizează alias-ul produsului (`product_aliases`), folosit la bonurile următoare. Bon salvat → 409 `receipt_saved`.",
    body: { schema: receiptPatchSchema },
    success: { status: 200, schema: dataOf(receiptDetailSchema), description: "Bonul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT, REUSED],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/receipts"),
    operationId: "deleteReceipt",
    tag: "receipts",
    summary: "Șterge bonul și documentele lui (fișierele); tranzacția creată rămâne.",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 204, schema: null, description: "Șters." },
    errors: [...MUTATION_ERRORS, NOT_FOUND],
  },
  {
    method: "POST",
    path: pathOf("/api/v1/receipts", "/confirm"),
    operationId: "confirmReceipt",
    tag: "receipts",
    summary: "„Confirmă și salvează”: creează tranzacția de cheltuială a bonului.",
    description:
      "O tranzacție per bon: suma = totalul, moneda contului = moneda bonului (altfel 409 `currency_mismatch`), `source: receipt`, `documentId`; categoria = cea trimisă sau categoria cu cea mai mare sumă pe liniile de produs; categoriile liniilor rămân pe bon. 409: `receipt_already_saved`, `possible_duplicate` (fără `allowDuplicate: true`), `total_required`, `date_required`, `account_archived`. Garda 2^53 pe sold (422).",
    body: { schema: receiptConfirmSchema },
    success: {
      status: 201,
      schema: dataOf(receiptConfirmResultSchema),
      description: "Bonul salvat și tranzacția.",
    },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "POST",
    path: pathOf("/api/v1/receipts", "/reprocess"),
    operationId: "reprocessReceipt",
    tag: "receipts",
    summary: "Citește din nou bonul (pune documentele în coadă; consumă limita zilnică).",
    description:
      "Bonul extras se șterge și documentele revin în coadă (workerul, în ≤ 1 minut; fără consimțământ → `awaiting_consent`). `order` (bon lung): pozele în ordinea nouă („Ordonează automat”). 409: `receipt_saved`, `file_deleted` (retenție), `document_rejected`, `daily_document_limit`. Limită proprie de cereri (429).",
    body: {
      schema: z.strictObject({
        order: z.array(z.number().int().min(1).max(4)).min(2).max(4).optional(),
      }),
      optional: true,
    },
    success: {
      status: 202,
      schema: dataOf(receiptReprocessResultSchema),
      description: "Documentele puse în coadă.",
    },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  // --- Plățile recurente (Faza 5) ------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/recurring",
    operationId: "listRecurring",
    tag: "recurring",
    summary: "Regulile recurente ale gospodăriei și contorul „active · scadente · total”.",
    description:
      "`counts` se calculează pe TOATE regulile (filtrul `status` nu îl schimbă). `due` = reguli scadente (active, cu o scadență negenerată ≤ azi, data din București).",
    query: [{ name: "status", schema: z.enum(RECURRING_STATUSES), description: "Doar o stare." }],
    success: {
      status: 200,
      schema: z.strictObject({
        data: z.array(recurringRuleSchema),
        counts: recurringCountsSchema,
      }),
      description: "Regulile și contorul.",
    },
    errors: [VALIDATION, REUSED],
  },
  {
    method: "POST",
    path: "/api/v1/recurring",
    operationId: "createRecurring",
    tag: "recurring",
    summary: "Creează o regulă recurentă (venit sau cheltuială; fără transferuri în Faza 5).",
    description:
      "Moneda = a contului (contul nearhivat). `dayOfMonth` doar la `monthly`/`yearly` (implicit ziua din `startOn`; 29–31 → ultima zi în lunile scurte, fără deplasarea zilei țintă). `interval` 1–100, `maxOccurrences` 1–1200, `description` obligatorie. Prima scadență = prima dată ≥ `startOn`; o regulă cu start în trecut are scadențele trecute „de generat” (recuperare limitată la 12 pe regulă pe rulare). Plafoane: cel mult 200 de reguli pe gospodărie (409 `recurring_limit_reached`); `startOn` cel mult 5 ani în urmă (400); fără `maxOccurrences`, cel mult 1200 de scadențe restante la creare (400).",
    body: { schema: recurringCreateSchema },
    success: { status: 201, schema: dataOf(recurringRuleSchema), description: "Regula creată." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: "/api/v1/recurring/summary",
    operationId: "getRecurringSummary",
    tag: "recurring",
    summary: "Doar contorul: reguli active · reguli scadente · total.",
    success: {
      status: 200,
      schema: dataOf(recurringCountsSchema),
      description: "Contorul.",
    },
    errors: [VALIDATION, NOT_FOUND],
  },
  {
    method: "POST",
    path: "/api/v1/recurring/generate",
    operationId: "generateRecurring",
    tag: "recurring",
    summary:
      "Generează acum tranzacțiile scadente ale gospodăriei curente; `Idempotency-Key` OBLIGATORIU.",
    description:
      "Rulează direct în serverul web, ca utilizatorul curent (RLS), nu prin coada workerului. Fără cheie → 400. Idempotent pe ocurență (`(rule_id, occurrence_date)`): o a doua generare creează 0 tranzacții; aceeași cheie întoarce același răspuns (`Idempotent-Replay: true`). Cel mult 12 scadențe ratate pe regulă la o rulare. Limită proprie, mai strânsă (429). Tranzacțiile au `source: recurring` și `recurringRuleId`.",
    body: { schema: z.strictObject({}), optional: true },
    success: {
      status: 200,
      schema: dataOf(recurringGenerateResultSchema),
      description: "Contoarele generării (fără sume).",
    },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "GET",
    path: pathOf("/api/v1/recurring"),
    operationId: "getRecurring",
    tag: "recurring",
    summary: "O regulă recurentă.",
    success: { status: 200, schema: dataOf(recurringRuleSchema), description: "Regula." },
    errors: [NOT_FOUND, REUSED],
  },
  {
    method: "PATCH",
    path: pathOf("/api/v1/recurring"),
    operationId: "patchRecurring",
    tag: "recurring",
    summary: "Modifică o regulă (tipul, `startOn` și starea nu se schimbă de aici).",
    description:
      "O schimbare de calendar recalculează scadența de la max(azi, ultima ocurență + 1 zi): nimic retroactiv, nimic dublat. Un cont în altă monedă cere și suma (409 `currency_change_requires_amount`); contul arhivat → 409 `account_archived`.",
    body: { schema: recurringUpdateSchema },
    success: { status: 200, schema: dataOf(recurringRuleSchema), description: "Regula." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT, REUSED],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/recurring"),
    operationId: "deleteRecurring",
    tag: "recurring",
    summary: "Șterge definitiv o regulă (auditat fără sume); tranzacțiile generate rămân.",
    success: { status: 204, schema: null, description: "Ștearsă." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA, TOO_LARGE],
  },
  {
    method: "POST",
    path: pathOf("/api/v1/recurring", "/pause"),
    operationId: "pauseRecurring",
    tag: "recurring",
    summary: "Pune regula pe pauză (una completată → 409 `recurring_completed`).",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(recurringRuleSchema), description: "Regula." },
    errors: [VALIDATION, FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA, TOO_LARGE, REUSED],
  },
  {
    method: "POST",
    path: pathOf("/api/v1/recurring", "/resume"),
    operationId: "resumeRecurring",
    tag: "recurring",
    summary: "Reia regula, FĂRĂ generarea retroactivă a scadențelor sărite.",
    description:
      "Scadența devine prima ≥ max(azi, scadența veche, ultima ocurență + 1 zi); fără scadențe rămase → `completed`. O regulă completată se reia doar dacă (după modificarea `endOn`/`maxOccurrences`) mai are scadențe; altfel 409 `recurring_completed`. Contul arhivat → 409 `account_archived` (dezarhivează contul sau mută regula pe alt cont).",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(recurringRuleSchema), description: "Regula." },
    errors: [VALIDATION, FORBIDDEN, NOT_FOUND, CONFLICT, MEDIA, TOO_LARGE, REUSED],
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
  // --- Familia (Faza 8, F8-B; ADR 0016, 0017) ------------------------------------------------
  {
    method: "PUT",
    path: "/api/v1/households/active",
    operationId: "setActiveHousehold",
    tag: "households",
    summary: "Setează gospodăria activă (comutatorul).",
    description:
      "Apartenența se verifică în bază, în aceeași tranzacție cu scrierea; o gospodărie străină sau inexistentă → 404. Preferința nu e o autorizare: la fiecare cerere API-ul o folosește doar dacă apartenența există încă (altfel cea mai veche gospodărie).",
    body: { schema: activeHouseholdSchema },
    success: {
      status: 200,
      schema: dataOf(householdSummarySchema),
      description: "Gospodăria activă (`current: true`).",
    },
    errors: [...MUTATION_ERRORS, NOT_FOUND],
  },
  {
    method: "GET",
    path: "/api/v1/family/members",
    operationId: "listFamilyMembers",
    tag: "family",
    summary: "Membrii gospodăriei curente (id, nume, rol; fără emailuri).",
    success: { status: 200, schema: dataOf(z.array(familyMemberSchema)), description: "Membrii." },
    errors: [VALIDATION, NOT_FOUND],
  },
  {
    method: "PATCH",
    path: pathOf("/api/v1/family/members"),
    operationId: "patchFamilyMember",
    tag: "family",
    summary: "Schimbă rolul unui membru (`{id}` = id-ul utilizatorului; doar owner).",
    description:
      "Ultimul owner nu poate fi retrogradat (409 `last_owner`); pentru a preda rolul: `transfer-ownership`. Un member → 403.",
    body: { schema: roleChangeSchema },
    success: { status: 200, schema: dataOf(familyMemberSchema), description: "Membrul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/family/members"),
    operationId: "removeFamilyMember",
    tag: "family",
    summary: "Scoate un membru (doar owner; pentru tine: `POST /family/leave`).",
    description:
      "Conturile personale ale celui scos devin invizibile pentru toți; împărțirile și decontările rămân în istoric. `unsettledBalance: true` = rămăseseră solduri nedecontate (avertisment). 409: `last_owner`, `use_leave`.",
    success: {
      status: 200,
      schema: dataOf(memberExitResultSchema),
      description: "Membrul a fost scos.",
    },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "POST",
    path: pathOf("/api/v1/family/members", "/transfer-ownership"),
    operationId: "transferFamilyOwnership",
    tag: "family",
    summary: "Predă rolul de proprietar: ținta devine owner, tu devii member (atomic).",
    body: { schema: z.strictObject({}), optional: true },
    success: {
      status: 200,
      schema: dataOf(z.array(familyMemberSchema)),
      description: "Membrii, după transfer.",
    },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "POST",
    path: "/api/v1/family/leave",
    operationId: "leaveHousehold",
    tag: "family",
    summary: "Părăsește gospodăria curentă.",
    description:
      "409: `last_owner` (transferă întâi rolul), `sole_member` (gospodăria se șterge, nu se părăsește). `unsettledBalance: true` = rămăseseră solduri nedecontate (avertisment, nu eroare).",
    body: { schema: z.strictObject({}), optional: true },
    success: {
      status: 200,
      schema: dataOf(memberExitResultSchema),
      description: "Ai părăsit gospodăria.",
    },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "GET",
    path: "/api/v1/family/invites",
    operationId: "listInvites",
    tag: "family",
    summary: "Invitațiile gospodăriei, cu starea (doar owner; FĂRĂ tokenuri).",
    success: { status: 200, schema: dataOf(z.array(inviteSchema)), description: "Invitațiile." },
    errors: [VALIDATION, FORBIDDEN, NOT_FOUND],
  },
  {
    method: "POST",
    path: "/api/v1/family/invites",
    operationId: "createInvite",
    tag: "family",
    summary: "Creează o invitație (doar owner); tokenul în clar apare O SINGURĂ DATĂ, aici.",
    description:
      "Valabilitate implicită 72 h (`expiresInHours` 1–168), rol implicit `member`. În bază se stochează doar SHA-256 al tokenului. NU acceptă `Idempotency-Key` (400): răspunsul memorat ar conține tokenul în clar. Limită: 20 de invitații / 24 h / gospodărie (409 `invite_limit`).",
    body: { schema: inviteCreateSchema.unwrap(), optional: true },
    success: { status: 201, schema: dataOf(createdInviteSchema), description: "Invitația creată." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "POST",
    path: pathOf("/api/v1/family/invites", "/revoke"),
    operationId: "revokeInvite",
    tag: "family",
    summary:
      "Revocă o invitație activă (doar owner). Deja folosită/revocată → 409 `invite_not_active`.",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(inviteSchema), description: "Invitația revocată." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "POST",
    path: "/api/v1/invites/accept",
    operationId: "acceptInvite",
    tag: "family",
    summary: "Acceptă o invitație pentru utilizatorul autentificat (tokenul în corp).",
    description:
      "Token inexistent, malformat, expirat, folosit sau revocat → ACELAȘI 404 `invite_unavailable` (fără enumerare). Limită: 10 încercări / 15 min per utilizator, consumată și la tokenurile greșite (429 + `Retry-After`). Deja membru → `joined: false`, invitația nu se consumă. La intrare, gospodăria devine cea activă. Gospodărie plină → 409 `household_full`. Fără `Idempotency-Key`: acceptarea e natural idempotentă.",
    body: { schema: inviteAcceptSchema },
    success: { status: 200, schema: dataOf(acceptInviteResultSchema), description: "Rezultatul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "GET",
    path: "/api/v1/family/balances",
    operationId: "getFamilyBalances",
    tag: "family",
    summary: "Soldurile reciproce (perechi, net pe membru, pe monedă) și rezumatul tău.",
    description:
      "Calculate din împărțiri și decontările neanulate, `bigint`, fără conversie între monede. `me`: „Ai de dat” (`owesMinor`) și „Ai de primit” (`owedMinor`). Pot apărea și foști membri (id fără nume în lista membrilor). Peste 2^53 → 422.",
    success: { status: 200, schema: dataOf(balancesSchema), description: "Soldurile." },
    errors: [VALIDATION, NOT_FOUND, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/family/settlements",
    operationId: "listSettlements",
    tag: "family",
    summary: "Decontările gospodăriei (cele mai noi întâi).",
    query: [
      {
        name: "includeCancelled",
        schema: boolParam,
        description: "Și cele anulate (implicit nu).",
      },
      { name: "limit", schema: intParam, description: "Câte (1–200, implicit 100)." },
    ],
    success: {
      status: 200,
      schema: dataOf(z.array(settlementSchema)),
      description: "Decontările.",
    },
    errors: [VALIDATION, NOT_FOUND, REUSED],
  },
  {
    method: "POST",
    path: "/api/v1/family/settlements",
    operationId: "createSettlement",
    tag: "family",
    summary: "Înregistrează o decontare (`fromUserId` i-a dat lui `toUserId` suma).",
    description:
      "Suma: `amountMinor` (întreg > 0) SAU `amount` text (`45,90`). O decontare parțială = o sumă mai mică decât soldul. Un member doar dacă e una dintre părți (altfel 403); un owner pentru oricare doi membri. Ambii trebuie să fie membri (400).",
    body: { schema: settlementCreateSchema },
    success: { status: 201, schema: dataOf(settlementSchema), description: "Decontarea." },
    errors: [...IDEMPOTENT_ERRORS, NOT_FOUND],
    idempotent: true,
  },
  {
    method: "POST",
    path: pathOf("/api/v1/family/settlements", "/cancel"),
    operationId: "cancelSettlement",
    tag: "family",
    summary: "Anulează o decontare (definitiv; istoricul rămâne). Deja anulată → 409.",
    body: { schema: z.strictObject({}), optional: true },
    success: { status: 200, schema: dataOf(settlementSchema), description: "Decontarea anulată." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "GET",
    path: "/api/v1/family/splits",
    operationId: "listSplits",
    tag: "family",
    summary: "Ultimele împărțiri ale gospodăriei (cine, cât, cine a plătit; fără descrieri).",
    query: [{ name: "limit", schema: intParam, description: "Câte (1–100, implicit 50)." }],
    success: { status: 200, schema: dataOf(z.array(splitSchema)), description: "Împărțirile." },
    errors: [VALIDATION, NOT_FOUND, REUSED],
  },
  {
    method: "GET",
    path: pathOf("/api/v1/transactions", "/split"),
    operationId: "getTransactionSplit",
    tag: "family",
    summary: "Împărțirea unei cheltuieli (orice membru; fără împărțire → 404).",
    success: { status: 200, schema: dataOf(splitSchema), description: "Împărțirea." },
    errors: [NOT_FOUND, REUSED],
  },
  {
    method: "PUT",
    path: pathOf("/api/v1/transactions", "/split"),
    operationId: "putTransactionSplit",
    tag: "family",
    summary: "Setează sau înlocuiește împărțirea unei cheltuieli (doar plătitorul).",
    description:
      "Doar o cheltuială din contul TĂU personal (409 `split_requires_personal_account`, `split_not_expense`). Moduri: `equal` (`userIds`), `percent` (`basisPoints`, 1% = 100, suma exact 10000), `fixed` (`amountMinor`, suma exact totalul). 2–6 membri distincți. Rotunjirea e deterministă (ADR 0016, punctul 7). Cât timp împărțirea există, suma, contul și tipul tranzacției nu se schimbă și tranzacția nu se șterge (409 `transaction_split`).",
    body: { schema: splitSetSchema },
    success: { status: 200, schema: dataOf(splitSchema), description: "Împărțirea." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT, REUSED],
  },
  {
    method: "DELETE",
    path: pathOf("/api/v1/transactions", "/split"),
    operationId: "deleteTransactionSplit",
    tag: "family",
    summary: "Elimină împărțirea (doar plătitorul; altfel 409 `split_not_payer`).",
    success: { status: 204, schema: null, description: "Eliminată." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "GET",
    path: "/api/v1/events",
    operationId: "getLiveEvents",
    tag: "family",
    summary: "Actualizările live ale gospodăriei curente (Server-Sent Events).",
    description:
      'Flux `text/event-stream`. Evenimente: `ready` (la conectare, cu `retry: 5000`), `change` (`data: {"type":"transaction|transfer|receipt|split|settlement|member","id":"<uuid>"}` — DOAR tipul și id-ul, fără sume sau nume; datele se recitesc prin API, cu RLS), `close` (sesiunea sau apartenența nu mai sunt valide; imediat la eliminare, plecare sau comutarea gospodăriei), `reconnect` (după 5 minute; clientul se reconectează), `evicted` (o conexiune mai nouă a aceluiași utilizator i-a luat locul). Comentariul `: ping` la 25 s (sub pragul de inactivitate al Cloudflare); la fiecare puls se reverifică sesiunea și apartenența. O tranzacție dintr-un cont personal ajunge doar la proprietarul contului. Cel mult 4 conexiuni per utilizator (la a cincea, cea mai veche primește `evicted`); 200 în total pe server (429). ADR 0017.',
    success: { status: 200, schema: null, sse: true, description: "Fluxul de evenimente." },
    errors: [VALIDATION, NOT_FOUND],
  },
  // --- Exporturile CSV -----------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/v1/exports/transactions.csv",
    operationId: "exportTransactionsCsv",
    tag: "exports",
    summary: "Exportul CSV al tranzacțiilor (filtrele listei), în flux.",
    description:
      "Aceleași filtre ca `GET /transactions`, fără `sort`, `cursor`, `limit` (ordine cronologică). Cel mult 50.000 de rânduri; peste → 409 `export_too_large` (JSON, fără conținut parțial). Cu sesiune prin cookie, ca toate exporturile, cere `Sec-Fetch-Site` = `same-origin` sau `none` (altfel 403 `forbidden`); cu bearer, antetul nu contează.",
    query: [...TRANSACTION_FILTERS, DIALECT_PARAM],
    success: csvSuccess("Fișierul `finet-tranzactii.csv`."),
    errors: [VALIDATION, FORBIDDEN, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/exports/goals.csv",
    operationId: "exportGoalsCsv",
    tag: "exports",
    summary: "Exportul CSV al obiectivelor (toate stările).",
    query: [DIALECT_PARAM],
    success: csvSuccess("Fișierul `finet-obiective.csv`."),
    errors: [VALIDATION, FORBIDDEN, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/exports/budgets.csv",
    operationId: "exportBudgetsCsv",
    tag: "exports",
    summary: "Exportul CSV al bugetelor active vizibile, cu starea într-o lună.",
    query: [MONTH_PARAM, DIALECT_PARAM],
    success: csvSuccess("Fișierul `finet-bugete.csv`."),
    errors: [VALIDATION, FORBIDDEN, REUSED],
  },
];

/** Operația după metodă și cale (pentru testele de contract). */
export function operation(method: HttpMethod, path: string): Operation {
  const op = OPERATIONS.find((o) => o.method === method && o.path === path);
  if (!op) throw new Error(`operație nedocumentată: ${method} ${path}`);
  return op;
}
