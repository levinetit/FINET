import { z } from "zod";

import {
  ACCOUNT_TYPES,
  AI_PROVIDERS_USED,
  DOCUMENT_KINDS,
  DOCUMENT_MIMES,
  DOCUMENT_STATUSES,
  FALLBACK_REASONS,
  PAYMENT_METHODS,
  RECEIPT_LINE_KINDS,
  RECEIPT_STATUSES,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  CATEGORY_KINDS,
  DB_CURRENCIES,
  GOAL_STATUSES,
  HOUSEHOLD_ROLES,
  RECURRING_FREQUENCIES,
  RECURRING_STATUSES,
  RECURRING_TYPES,
  THEMES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
  TRANSFER_DIRECTIONS,
} from "@/db/schema";
import { sessionViewSchema } from "@/modules/sessions/sessions.schema";

/**
 * Schemele RĂSPUNSURILOR API (OpenAPI, ADR 0005). Răspunsurile reale sunt construite de funcțiile
 * `*ToJson` din module; testele de integrare verifică răspunsurile reale cu aceste scheme
 * (`assertContract` din `src/app/api/v1/_lib/testing.ts`, apelat la fiecare răspuns din testele
 * `src/app/api/v1/*.test.ts`), ca documentația să nu se depărteze de cod.
 */

const uuid = z.uuid();
const instant = z.iso.datetime().meta({ description: "Moment ISO 8601 în UTC." });
const date = z.iso.date().meta({ description: "Dată calendaristică `YYYY-MM-DD`." });
const minor = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .meta({ description: "Sumă în unități minore (întreg, sub 2^53); niciodată zecimale." });
const currency = z.enum(DB_CURRENCIES);

export const errorSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.string(),
      message: z.string(),
      fields: z.record(z.string(), z.string()).optional(),
      reason: z.string().optional(),
    }),
  })
  .meta({ title: "Error" });

export const moneySchema = z
  .strictObject({ amountMinor: minor, currency })
  .meta({ title: "Money" });

export const accountSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    currency,
    openingBalanceMinor: minor,
    balanceMinor: minor.meta({ description: "Sold calculat (nu stocat)." }),
    bankCode: z.string().nullable(),
    ownerUserId: uuid.nullable(),
    archived: z.boolean(),
    archivedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Account" });

export const categorySchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    kind: z.enum(CATEGORY_KINDS),
    parentId: uuid.nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    hidden: z.boolean(),
    isSystem: z.boolean(),
    systemKey: z.string().nullable(),
  })
  .meta({ title: "Category" });

export const transactionSchema = z
  .strictObject({
    id: uuid,
    accountId: uuid,
    categoryId: uuid.nullable(),
    type: z.enum(TRANSACTION_TYPES),
    amountMinor: minor,
    currency,
    occurredOn: date,
    description: z.string().nullable(),
    merchant: z.string().nullable(),
    notes: z.string().nullable(),
    source: z.enum(TRANSACTION_SOURCES),
    transferGroupId: uuid.nullable(),
    transferDirection: z.enum(TRANSFER_DIRECTIONS).nullable(),
    recurringRuleId: uuid
      .nullable()
      .meta({ description: "Regula recurentă care a generat-o (`source: recurring`, Faza 5)." }),
    documentId: uuid.nullable().meta({
      description:
        "Documentul (bonul) din care a fost creată (`source: receipt`, Faza 6); `null` după ștergerea documentului.",
    }),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
    updatedAt: instant,
    tags: z
      .array(z.strictObject({ id: uuid, name: z.string(), color: z.string().nullable() }))
      .meta({ description: "Etichetele tranzacției (ordonate după nume); `[]` la transferuri." }),
  })
  .meta({ title: "Transaction" });

const transferLeg = z.strictObject({
  transactionId: uuid,
  accountId: uuid,
  amountMinor: minor,
  currency,
});

export const transferSchema = z
  .strictObject({
    id: uuid.meta({ description: "`transfer_group_id`." }),
    from: transferLeg,
    to: transferLeg,
    occurredOn: date,
    description: z.string().nullable(),
    notes: z.string().nullable(),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
  })
  .meta({ title: "Transfer" });

export const householdSummarySchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    defaultCurrency: currency,
    timezone: z.string(),
    role: z.enum(HOUSEHOLD_ROLES),
    current: z.boolean(),
    joinedAt: instant,
  })
  .meta({ title: "HouseholdSummary" });

export const householdDetailSchema = householdSummarySchema
  .extend({
    members: z.array(
      z.strictObject({
        userId: uuid,
        name: z.string(),
        role: z.enum(HOUSEHOLD_ROLES),
        joinedAt: instant,
      }),
    ),
  })
  .meta({ title: "HouseholdDetail" });

export const consentStateSchema = z
  .strictObject({
    kind: z.enum(["usageStats", "externalAi", "externalAiStatements"]),
    granted: z.boolean(),
    grantedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .meta({ title: "ConsentState" });

export const meSchema = z
  .strictObject({
    user: z.strictObject({
      id: uuid,
      email: z.string(),
      name: z.string(),
      emailVerified: z.boolean(),
      isPlatformAdmin: z.boolean(),
      createdAt: instant,
    }),
    preferences: z.strictObject({
      locale: z.string(),
      timezone: z.string(),
      defaultCurrency: currency,
      theme: z.enum(THEMES),
    }),
    household: z
      .strictObject({
        id: uuid,
        name: z.string(),
        defaultCurrency: currency,
        timezone: z.string(),
        role: z.enum(HOUSEHOLD_ROLES),
      })
      .nullable(),
  })
  .meta({ title: "Me" });

export const sessionSchema = sessionViewSchema.meta({ title: "Session" });

// --- Planificare și raportare (Faza 3, F3-B) --------------------------------------------------

const int = z.number().int();
const percent = int.meta({ description: "Procent întreg (fără float pe sume)." });

export const tagSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    color: z.string().nullable(),
    hidden: z.boolean(),
    isSystem: z.boolean(),
    systemKey: z.string().nullable(),
    usageCount: int.meta({ description: "Tranzacțiile gospodăriei care au eticheta." }),
  })
  .meta({ title: "Tag" });

export const budgetSchema = z
  .strictObject({
    id: uuid,
    categoryId: uuid.nullable().meta({ description: "`null` = buget general." }),
    period: z.enum(BUDGET_PERIODS),
    amountMinor: minor,
    currency,
    warnPct: int,
    scope: z.enum(BUDGET_SCOPES),
    userId: uuid.nullable().meta({ description: "Proprietarul unui buget `personal`." }),
    archivedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Budget" });

export const budgetStatusSchema = budgetSchema
  .extend({
    month: z.string().meta({ description: "Luna `YYYY-MM`." }),
    spentMinor: minor.meta({
      description: "Cheltuielile lunii în moneda bugetului (fără transferuri).",
    }),
    remainingMinor: minor.meta({ description: "`amountMinor − spentMinor`; negativ la depășire." }),
    percent: percent.meta({
      description: "`floor(spent × 100 / amount)`, limitat la 1.000.000 (doar afișare).",
    }),
    status: z.enum(["green", "yellow", "red"]).meta({
      description:
        "Semaforul din comparații exacte: verde sub `warnPct`, galben de la `warnPct` până la 100% inclusiv, roșu peste 100%.",
    }),
  })
  .meta({ title: "BudgetStatus" });

export const goalSchema = z
  .strictObject({
    id: uuid,
    name: z.string(),
    targetMinor: minor,
    savedMinor: minor,
    currency,
    deadline: date.nullable(),
    status: z.enum(GOAL_STATUSES),
    accountId: uuid.nullable(),
    progressPct: percent.meta({
      description: "`floor(saved × 100 / target)`; poate trece de 100.",
    }),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "Goal" });

const totals = z.strictObject({
  incomeMinor: minor,
  expenseMinor: minor,
  netMinor: minor,
  transactionCount: int.meta({ description: "Venituri + cheltuieli (fără transferuri)." }),
});
const delta = z.strictObject({
  diffMinor: minor,
  percent: int.nullable().meta({ description: "`null` când luna anterioară e 0." }),
});

export const dashboardSchema = z
  .strictObject({
    month: z.string(),
    previousMonth: z.string(),
    onboarding: z.strictObject({
      hasAccount: z.boolean(),
      hasTransaction: z.boolean(),
      hasBudget: z.boolean(),
      hasGoal: z.boolean(),
      steps: z.array(
        z.strictObject({ key: z.enum(["import", "budget", "goal"]), done: z.boolean() }),
      ),
      completed: z.boolean(),
    }),
    currencies: z.array(
      z.strictObject({
        currency,
        totals,
        previous: totals,
        comparison: z.strictObject({ income: delta, expense: delta, net: delta }),
        byCategory: z.array(
          z.strictObject({
            categoryId: uuid.nullable(),
            name: z.string().nullable(),
            isOther: z.boolean(),
            amountMinor: minor,
            percent,
          }),
        ),
        monthly: z.array(
          z.strictObject({
            month: z.string(),
            incomeMinor: minor,
            expenseMinor: minor,
            netMinor: minor,
          }),
        ),
        daily: z.array(z.strictObject({ date, incomeMinor: minor, expenseMinor: minor })),
      }),
    ),
  })
  .meta({ title: "Dashboard" });

export const monthlyReportSchema = z
  .strictObject({
    month: z.string(),
    currencies: z.array(
      z.strictObject({
        currency,
        totals,
        byCategory: z.array(
          z.strictObject({
            categoryId: uuid.nullable(),
            name: z.string().nullable(),
            amountMinor: minor,
            count: int,
            percent,
            children: z.array(
              z.strictObject({
                categoryId: uuid.nullable(),
                name: z.string().nullable(),
                amountMinor: minor,
                count: int,
              }),
            ),
          }),
        ),
        topMerchants: z.array(
          z.strictObject({ merchant: z.string(), amountMinor: minor, count: int }),
        ),
      }),
    ),
    budgets: z.array(budgetStatusSchema),
    goals: z.array(goalSchema),
  })
  .meta({ title: "MonthlyReport" });

/** `{ data }` */
export const recurringRuleSchema = z
  .strictObject({
    id: uuid,
    accountId: uuid,
    categoryId: uuid.nullable(),
    type: z.enum(RECURRING_TYPES),
    amountMinor: minor,
    currency,
    description: z.string(),
    merchant: z.string().nullable(),
    frequency: z.enum(RECURRING_FREQUENCIES),
    interval: int.min(1),
    dayOfMonth: int.min(1).max(31).nullable(),
    startOn: date,
    nextRunOn: date.meta({ description: "Următoarea scadență negenerată." }),
    endOn: date.nullable(),
    maxOccurrences: int.nullable(),
    occurrencesCount: int,
    status: z.enum(RECURRING_STATUSES),
    due: z
      .boolean()
      .meta({ description: "Regula e activă și are o scadență negenerată ≤ azi (București)." }),
    lastErrorCode: z.string().nullable().meta({
      description:
        "Codul ultimei generări eșuate (fără detalii); `account_archived` = pusă pe pauză automat pentru că are contul arhivat.",
    }),
    createdAt: instant,
    updatedAt: instant,
  })
  .meta({ title: "RecurringRule" });

export const recurringCountsSchema = z
  .strictObject({
    active: int.meta({ description: "Reguli active." }),
    due: int.meta({
      description:
        "Reguli SCADENTE: active, cu o scadență negenerată ≤ azi (nu numărul de ocurențe în așteptare).",
    }),
    total: int.meta({ description: "Toate regulile (orice stare)." }),
  })
  .meta({ title: "RecurringCounts" });

export const recurringGenerateResultSchema = z
  .strictObject({
    today: date.meta({ description: "„Azi” folosit (data locală din București)." }),
    rules: int.meta({ description: "Reguli scadente procesate." }),
    generated: int.meta({ description: "Tranzacții create acum (0 la o a doua rulare)." }),
    failed: int.meta({ description: "Reguli la care generarea a eșuat (reîncercate mai târziu)." }),
    skipped: int.meta({
      description:
        "Reguli sărite (blocate de o generare paralelă, puse pe pauză din cauza contului arhivat etc.).",
    }),
  })
  .meta({ title: "RecurringGenerateResult" });

// --- Documentele și bonurile (Faza 6) ---------------------------------------------------------

const documentBase = {
  id: uuid,
  kind: z.enum(DOCUMENT_KINDS),
  status: z.enum(DOCUMENT_STATUSES).meta({
    description:
      "`awaiting_consent` = fără consimțământul `externalAi` nimic nu pleacă la AI (bonul se poate introduce manual); `queued` → `processing` → `needs_review` (bonul „De verificat”) → `done` (salvat); `rejected` = fișierul a fost refuzat la preprocesare (`errorCode`).",
  }),
  mime: z.enum(DOCUMENT_MIMES).meta({ description: "Tipul DETECTAT după conținut." }),
  sizeBytes: int,
  pages: int.nullable(),
  batchId: uuid.nullable().meta({ description: "Lotul bonului lung (2–4 poze)." }),
  documentOrder: int.nullable().meta({ description: "Poziția în bonul lung (1 = sus)." }),
  possibleDuplicateOfId: uuid
    .nullable()
    .meta({ description: "Poză aproape identică (hash perceptual): informativ, nu blochează." }),
  errorCode: z
    .string()
    .nullable()
    .meta({ description: "Cod stabil al refuzului (fără conținut), de exemplu `pdf_encrypted`." }),
  createdAt: instant,
  expiresAt: instant.nullable().meta({ description: "Ștergerea originalului (retenția)." }),
  fileDeleted: z.boolean().meta({ description: "Originalul a fost șters la retenție." }),
};

export const uploadedDocumentSchema = z
  .strictObject({
    ...documentBase,
    duplicate: z
      .boolean()
      .meta({ description: "Același fișier (SHA-256) exista deja: documentul existent." }),
  })
  .meta({ title: "UploadedDocument" });

export const documentSchema = z
  .strictObject({
    ...documentBase,
    receiptId: uuid.nullable().meta({ description: "Bonul extras din document (sau din lot)." }),
  })
  .meta({ title: "Document" });

export const uploadResultSchema = z
  .strictObject({
    documents: z.array(uploadedDocumentSchema),
    batchId: uuid.nullable(),
    created: int.meta({ description: "Documente noi (fără duplicate)." }),
  })
  .meta({ title: "UploadResult" });

/** Faza 9 (promptul Android 12.1): ultima versiune Android publicată. */
export const androidReleaseSchema = z
  .strictObject({
    versionName: z
      .string()
      .meta({ description: "Versiunea semantică (`1.0.0`, din tagul `FINET-v1.0.0`)." }),
    versionCode: int.meta({ description: "Crește monoton cu fiecare build publicat." }),
    minSupportedVersionCode: int.meta({
      description:
        "Sub această valoare aplicația cere actualizarea și nu mai trimite cereri financiare.",
    }),
    url: z.string().meta({ description: "Linkul de descărcare (https; GitHub Releases)." }),
    sha256: z.string().meta({ description: "Suma SHA-256 a APK-ului (hex, 64 de caractere)." }),
    sizeBytes: int.meta({ description: "Dimensiunea APK-ului, în octeți." }),
    notes: z
      .string()
      .meta({ description: "Notele versiunii, în română (cel mult 2000 de caractere)." }),
    publishedAt: z
      .string()
      .nullable()
      .meta({ description: "Momentul publicării (ISO 8601) sau `null`." }),
  })
  .meta({ title: "AndroidRelease" });

export const aiUsageSchema = z
  .strictObject({
    used: int.meta({ description: "Documente încărcate azi (ziua din București)." }),
    limit: int.meta({ description: "Limita zilnică a gospodăriei." }),
    remaining: int,
  })
  .meta({ title: "AiUsage" });

const receiptIssue = z.strictObject({
  code: z.string().meta({ description: "Cod stabil (ADR 0014), tradus de UI." }),
  field: z.string().optional(),
  line: int.optional().meta({ description: "Poziția liniei (1..500)." }),
});

const receiptBase = {
  id: uuid,
  status: z.enum(RECEIPT_STATUSES),
  documentIds: z.array(uuid).meta({ description: "Documentele (pozele) bonului, în ordine." }),
  batchId: uuid.nullable(),
  merchantName: z.string().nullable(),
  merchantTaxId: z.string().nullable().meta({ description: "CUI (`RO` opțional + cifre)." }),
  storeAddress: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  occurredOn: date.nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  totalMinor: minor.nullable(),
  vatTotalMinor: minor.nullable(),
  currency,
  confidence: int
    .nullable()
    .meta({ description: "0–100, calculat DOAR din verificările din cod." }),
  providerUsed: z.enum(AI_PROVIDERS_USED),
  fallbackReason: z.enum(FALLBACK_REASONS).nullable(),
  transactionId: uuid.nullable().meta({ description: "Tranzacția creată la confirmare." }),
  duplicateOfReceiptId: uuid
    .nullable()
    .meta({ description: "Același bon (CUI + număr + dată + total) există deja." }),
  issues: z.array(receiptIssue),
  linesSumMinor: minor.nullable().meta({ description: "Suma liniilor cu semn (reducerile scad)." }),
  categoryIds: z.array(uuid).meta({ description: "Categoriile distincte ale liniilor." }),
  lineCount: int,
  createdAt: instant,
  updatedAt: instant,
};

export const receiptSchema = z.strictObject(receiptBase).meta({ title: "Receipt" });

export const receiptLineSchema = z
  .strictObject({
    id: uuid,
    position: int,
    rawName: z.string(),
    normalizedName: z.string().nullable(),
    quantity: z
      .string()
      .nullable()
      .meta({ description: 'Cantitatea ca text zecimal (`"1.500"`), fără float.' }),
    unitPriceMinor: minor.nullable(),
    lineTotalMinor: minor,
    vatRate: z.string().nullable().meta({ description: 'Cota TVA în procente (`"21.00"`).' }),
    categoryId: uuid.nullable(),
    kind: z.enum(RECEIPT_LINE_KINDS),
  })
  .meta({ title: "ReceiptLine" });

export const receiptDetailSchema = z
  .strictObject({
    ...receiptBase,
    lines: z.array(receiptLineSchema),
    removedLines: z
      .array(
        z.strictObject({
          part: int,
          position: int,
          reason: z.literal("overlap"),
          name: z.string().nullable(),
        }),
      )
      .meta({ description: "Bonul lung: liniile eliminate la unire (poza 1..4, rândul)." }),
    removedCount: int,
    suggestedOrder: z
      .array(int)
      .nullable()
      .meta({ description: "Bonul lung în ordine greșită: ordinea propusă a pozelor." }),
  })
  .meta({ title: "ReceiptDetail" });

export const receiptConfirmResultSchema = z
  .strictObject({ receipt: receiptDetailSchema, transactionId: uuid })
  .meta({ title: "ReceiptConfirmResult" });

export const receiptReprocessResultSchema = z
  .strictObject({ documentIds: z.array(uuid), queued: int })
  .meta({ title: "ReceiptReprocessResult" });

export const dataOf = <T extends z.ZodType>(schema: T) => z.strictObject({ data: schema });

// --- Familia (Faza 8, F8-B; ADR 0016, 0017) ----------------------------------------------------

export const familyMemberSchema = z
  .strictObject({
    userId: uuid,
    name: z.string(),
    role: z.enum(HOUSEHOLD_ROLES),
    joinedAt: instant,
  })
  .meta({ title: "FamilyMember" });

export const inviteSchema = z
  .strictObject({
    id: uuid,
    role: z.enum(HOUSEHOLD_ROLES),
    status: z.enum(["active", "used", "revoked", "expired"]),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
    expiresAt: instant,
    usedAt: instant.nullable(),
    usedByUserId: uuid.nullable(),
    revokedAt: instant.nullable(),
  })
  .meta({ title: "Invite", description: "O invitație, FĂRĂ token (în bază e doar hash-ul)." });

export const createdInviteSchema = z
  .strictObject({
    invite: inviteSchema,
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .meta({
        description: "Tokenul în clar (256 de biți, base64url). Apare O SINGURĂ DATĂ, aici.",
      }),
    joinPath: z.string().meta({ description: "Calea paginii de acceptare: `/join/<token>`." }),
  })
  .meta({ title: "CreatedInvite" });

export const acceptInviteResultSchema = z
  .strictObject({
    householdId: uuid,
    joined: z.boolean().meta({ description: "`false` = erai deja membru (nimic consumat)." }),
  })
  .meta({ title: "AcceptInviteResult" });

export const memberExitResultSchema = z
  .strictObject({
    unsettledBalance: z.boolean().meta({
      description: "`true` = rămăseseră solduri nedecontate (avertisment, nu eroare).",
    }),
  })
  .meta({ title: "MemberExitResult" });

export const splitSchema = z
  .strictObject({
    transactionId: uuid,
    payerUserId: uuid,
    currency,
    totalMinor: minor,
    shares: z.array(z.strictObject({ userId: uuid, shareMinor: minor })),
    createdAt: instant,
  })
  .meta({ title: "Split" });

export const balancesSchema = z
  .strictObject({
    currencies: z.array(
      z.strictObject({
        currency,
        pairs: z.array(
          z.strictObject({ debtorUserId: uuid, creditorUserId: uuid, amountMinor: minor }),
        ),
        members: z.array(z.strictObject({ userId: uuid, netMinor: minor })),
      }),
    ),
    formerMemberIds: z.array(uuid).meta({
      description: "Utilizatorii din solduri care nu mai sunt membri („fost membru”; fără nume).",
    }),
    me: z.array(z.strictObject({ currency, owesMinor: minor, owedMinor: minor })),
  })
  .meta({ title: "Balances" });

export const settlementSchema = z
  .strictObject({
    id: uuid,
    fromUserId: uuid,
    toUserId: uuid,
    amountMinor: minor,
    currency,
    settledOn: date,
    note: z.string().nullable(),
    createdByUserId: uuid.nullable(),
    createdAt: instant,
    cancelledAt: instant.nullable(),
    cancelledByUserId: uuid.nullable(),
  })
  .meta({ title: "Settlement" });
