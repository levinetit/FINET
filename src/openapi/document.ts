import { z } from "zod";

import { MAX_EVENTS_PER_BATCH } from "@/modules/usage/usage.schema";

import { type Operation, OPERATIONS } from "./registry";
import {
  accountSchema,
  budgetSchema,
  budgetStatusSchema,
  categorySchema,
  consentStateSchema,
  dashboardSchema,
  errorSchema,
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
 * Documentul OpenAPI 3.1 al API-ului `/api/v1`, construit din registrul `./registry` și din
 * schemele Zod (`z.toJSONSchema`, JSON Schema 2020-12, compatibil OpenAPI 3.1). Determinist:
 * căile și metodele sunt ordonate, deci același cod dă același fișier (`pnpm openapi:check`).
 */

type Json = Record<string, unknown>;

/** Corpul unei cereri: forma de INTRARE (înainte de `transform`), fără verificările nereprezentabile. */
function requestSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
}

function responseSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }) as Json;
}

/** Entitățile răspunsurilor, emise o singură dată în `components.schemas` și referite prin `$ref`. */
const COMPONENTS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["Account", accountSchema],
  ["Budget", budgetSchema],
  ["BudgetStatus", budgetStatusSchema],
  ["Category", categorySchema],
  ["ConsentState", consentStateSchema],
  ["Dashboard", dashboardSchema],
  ["Error", errorSchema],
  ["Goal", goalSchema],
  ["HouseholdDetail", householdDetailSchema],
  ["HouseholdSummary", householdSummarySchema],
  ["Me", meSchema],
  ["Money", moneySchema],
  ["MonthlyReport", monthlyReportSchema],
  ["Session", sessionSchema],
  ["Tag", tagSchema],
  ["Transaction", transactionSchema],
  ["Transfer", transferSchema],
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`)
    .join(",")}}`;
}

/** Înlocuiește orice sub-schemă identică unei componente cu `$ref` (în afară de rădăcina ei). */
function refify(node: unknown, refs: ReadonlyMap<string, string>, root = true): unknown {
  if (node === null || typeof node !== "object") return node;
  if (!root) {
    const name = refs.get(canonical(node));
    if (name) return { $ref: `#/components/schemas/${name}` };
  }
  if (Array.isArray(node)) return node.map((n) => refify(n, refs, false));
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, refify(v, refs, false)]));
}

function componentSchemas(): { schemas: Json; refs: Map<string, string> } {
  const schemas: Json = {};
  const refs = new Map<string, string>();
  for (const [name, schema] of COMPONENTS) {
    const json = strip(responseSchema(schema));
    schemas[name] = json;
    refs.set(canonical(json), name);
  }
  // Componentele se pot referi una pe alta (de exemplu `Money` în altă entitate).
  for (const [name] of COMPONENTS) schemas[name] = refify(schemas[name], refs, true);
  return { schemas, refs };
}

function strip(schema: Json): Json {
  // `$schema` e implicit în OpenAPI 3.1 (dialectul JSON Schema 2020-12).
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "Cerere invalidă (`invalid_request`, cu `fields` pe câmp; mesaje fixe, fără ecoul valorilor).",
  401: "Fără sesiune validă (`unauthenticated`).",
  403: "Interzis (`forbidden`): mutație cu cookie fără `Origin` corect (CSRF), export CSV cu cookie fără `Sec-Fetch-Site` `same-origin`/`none`, sau rol insuficient.",
  404: "Resursa nu există sau aparține altei gospodării (`not_found`, răspuns uniform).",
  409: "Conflict cu starea curentă (`conflict`, cu `reason`) sau `request_in_progress` (aceeași `Idempotency-Key` e în curs).",
  413: "Corpul depășește 16 KiB (`payload_too_large`). La încărcarea documentelor: `payload_too_large`, `file_too_large`, `too_many_files`, `image_too_large`.",
  415: "Corpul nu e `application/json` (`unsupported_media_type`). La încărcarea documentelor: `unsupported_media_type` (nu e multipart), `unsupported_type`, `heic_unsupported`, `markup_content`.",
  422: "`Idempotency-Key` folosită pentru o altă cerere (`idempotency_key_reused`) sau un sold calculat care nu poate fi transmis exact (`amount_out_of_range`, peste 2^53 − 1). La încărcarea documentelor: `invalid_image` (imagine care nu poate fi citită).",
  429: "Prea multe cereri (`rate_limited`, antet `Retry-After`).",
  500: "Eroare internă (`internal_error`, fără detalii).",
  503: "Serverul e ocupat (`statement_upload_busy`: prea multe încărcări de extrase simultane), antet `Retry-After`.",
};

const COMMON_ERRORS = [401, 429, 500];

function pathParams(path: string): Json[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) =>
    m[1] === "signature"
      ? {
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
          description: "Amprenta propunerii (SHA-256 hex). Una necunoscută sau invizibilă dă 404.",
        }
      : {
          name: m[1],
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Id (uuid). Un id invalid sau al altei gospodării dă 404.",
        },
  );
}

function operationObject(op: Operation, refs: ReadonlyMap<string, string>): Json {
  const parameters: Json[] = [
    ...pathParams(op.path),
    ...(op.query ?? []).map((q) => ({
      name: q.name,
      in: "query",
      required: false,
      description: q.description,
      schema: strip(requestSchema(q.schema)),
    })),
    ...(op.headers ?? []).map((h) => ({
      name: h.name,
      in: "header",
      required: false,
      description: h.description,
      schema: { type: "string", maxLength: 64 },
    })),
    { $ref: "#/components/parameters/FinetClient" },
  ];
  if (op.idempotent) parameters.push({ $ref: "#/components/parameters/IdempotencyKey" });

  const responses: Json = {};
  const success: Json = { description: op.success.description };
  if (op.success.binary) {
    success.content = Object.fromEntries(
      op.success.binary.map((type) => [type, { schema: { type: "string", format: "binary" } }]),
    );
    success.headers = {
      "Content-Disposition": {
        description:
          '`attachment; filename="…"` (nume generat de server, fără date ale utilizatorului).',
        schema: { type: "string" },
      },
      "X-Content-Type-Options": { description: "`nosniff`.", schema: { type: "string" } },
    };
  } else if (op.success.sse) {
    success.content = { "text/event-stream": { schema: { type: "string" } } };
  } else if (op.success.csv) {
    success.content = { "text/csv; charset=utf-8": { schema: { type: "string" } } };
    success.headers = {
      "Content-Disposition": {
        description: '`attachment; filename="…"` cu un nume fix (fără date ale utilizatorului).',
        schema: { type: "string" },
      },
    };
  } else if (op.success.schema) {
    const schema = refify(strip(responseSchema(op.success.schema)), refs, false);
    success.content = { "application/json": { schema } };
  }
  if (op.idempotent) {
    success.headers = { "Idempotent-Replay": { $ref: "#/components/headers/IdempotentReplay" } };
  }
  responses[String(op.success.status)] = success;
  if (op.success.alsoStatus !== undefined) responses[String(op.success.alsoStatus)] = success;
  for (const status of [...new Set([...op.errors, ...COMMON_ERRORS])].sort((a, b) => a - b)) {
    responses[String(status)] = { $ref: `#/components/responses/E${status}` };
  }

  const result: Json = {
    operationId: op.operationId,
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    parameters,
  };
  if (op.multipart) {
    result.requestBody = {
      required: true,
      description: op.multipart.description,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: {
              ...Object.fromEntries(
                Object.entries(op.multipart.fields).map(([name, description]) => [
                  name,
                  name === "files"
                    ? { type: "array", items: { type: "string", format: "binary" }, description }
                    : { type: "string", description },
                ]),
              ),
            },
            required: ["files"],
          },
        },
      },
    };
  }
  if (op.body) {
    result.requestBody = {
      required: !op.body.optional,
      content: { "application/json": { schema: strip(requestSchema(op.body.schema)) } },
    };
  }
  result.responses = responses;
  return result;
}

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function buildOpenApiDocument(): Json {
  const { schemas, refs } = componentSchemas();
  const paths: Json = {};
  const sorted = [...OPERATIONS].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
  );
  for (const op of sorted) {
    const item = (paths[op.path] ??= {}) as Json;
    item[op.method.toLowerCase()] = operationObject(op, refs);
  }

  const errorResponses: Json = {};
  for (const status of Object.keys(ERROR_DESCRIPTIONS).map(Number)) {
    errorResponses[`E${status}`] = {
      description: ERROR_DESCRIPTIONS[status],
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      ...(status === 429
        ? { headers: { "Retry-After": { schema: { type: "integer" }, description: "Secunde." } } }
        : {}),
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "FINET API",
      version: "1",
      description:
        "API-ul REST versionat al FINET (master prompt 6.4). Sumele sunt întregi în unități minore (`amountMinor`) cu `currency`; datele `YYYY-MM-DD`; momentele ISO 8601 UTC. Detalii: docs/API.md, docs/adr/0005-api-v1.md, docs/adr/0007-planning-reporting.md.",
    },
    servers: [
      {
        url: "https://finet.example",
        description: "Exemplu (hostname-ul real îl alege operatorul).",
      },
    ],
    security: [{ cookieSession: [] }, { bearerSession: [] }],
    tags: [
      { name: "me", description: "Contul curent (Faza 1) și consimțămintele." },
      { name: "usage", description: "Statisticile de utilizare (6.5)." },
      { name: "app", description: "Aplicația Android: ultima versiune publicată (Faza 9)." },
      { name: "admin", description: "Administratorul platformei: statisticile (Faza 9)." },
      { name: "households", description: "Gospodăriile utilizatorului." },
      {
        name: "family",
        description: "Familia (Faza 8): membri, invitații, împărțiri, solduri, decontări, live.",
      },
      { name: "accounts", description: "Conturile." },
      { name: "categories", description: "Categoriile." },
      { name: "transactions", description: "Tranzacțiile (venituri, cheltuieli)." },
      { name: "transfers", description: "Transferurile între conturi." },
      { name: "tags", description: "Etichetele (Faza 3)." },
      { name: "budgets", description: "Bugetele lunare și semaforul (Faza 3)." },
      { name: "goals", description: "Obiectivele de economisire (Faza 3)." },
      {
        name: "shopping",
        description:
          "Listele de cumpărături (comune sau personale) și comparația listă ↔ bon (Faza 10, ADR 0022).",
      },
      { name: "recurring", description: "Plățile recurente (Faza 5)." },
      { name: "documents", description: "Documentele încărcate (bonuri; Faza 6)." },
      { name: "receipts", description: "Bonurile extrase, verificarea și confirmarea (Faza 6)." },
      {
        name: "statements",
        description:
          "Extrasele bancare (Faza 7): încărcare, previzualizare, confirmare, anulare, acoperire.",
      },
      {
        name: "matching",
        description: "Potrivirea bon ↔ tranzacție din extras și propunerile de recurențe (Faza 7).",
      },
      {
        name: "reports",
        description:
          "Dashboard-ul, raportul lunar (Faza 3) și rapoartele de micro-cheltuieli (Faza 10).",
      },
      {
        name: "prices",
        description: "Prețurile pe produs și comerciant, inflația personală (Faza 10).",
      },
      { name: "exports", description: "Exporturile CSV (Faza 3)." },
    ],
    paths,
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: "finet.session_token",
          description:
            "Sesiunea web (Better Auth). Mutațiile cu cookie cer `Origin` egal cu originea aplicației (CSRF). În producție numele are prefixul `__Secure-`.",
        },
        bearerSession: {
          type: "http",
          scheme: "bearer",
          description:
            "Tokenul semnat din antetul `set-auth-token` al login-ului (clientul Android).",
        },
      },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description:
            "16–128 caractere `[A-Za-z0-9_-]` (de exemplu un UUID). Aceeași cheie și aceeași cerere în 24 h întorc răspunsul inițial (antet `Idempotent-Replay: true`), fără a doua scriere; altă cerere cu aceeași cheie → 422; cerere în curs → 409 `request_in_progress`. Erorile 5xx nu se memorează.",
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" },
        },
        FinetClient: {
          name: "X-FINET-Client",
          in: "header",
          required: false,
          description: `Informații despre client (6.5), perechi \`cheie=valoare\` separate prin \`;\`: \`platform\` (android|web, obligatoriu), \`installation\` (uuid, obligatoriu), \`version\`, \`code\`, \`os\`, \`model\`, \`locale\`. Exemplu: \`platform=android; version=1.0.2; code=10002; installation=<uuid>; os=14; model=Pixel 8; locale=ro-RO\`. Un antet invalid e ignorat (nu blochează cererea). Forma veche \`android/<versiune>\` e acceptată pentru sesiuni, fără instalare. Loturile de evenimente: cel mult ${MAX_EVENTS_PER_BATCH}.`,
          schema: { type: "string", maxLength: 400 },
        },
      },
      headers: {
        IdempotentReplay: {
          description: "`true` când răspunsul e reluat dintr-o cerere anterioară cu aceeași cheie.",
          schema: { type: "string", enum: ["true"] },
        },
      },
      responses: errorResponses,
      schemas,
    },
  };
}

/** Textul fișierului `docs/openapi.json` (JSON cu 2 spații, linie nouă la final). */
export function renderOpenApi(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
