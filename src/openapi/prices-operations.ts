import { z } from "zod";

import { DB_CURRENCIES } from "@/db/schema";
import { INFLATION_BASELINES, REPORT_PERIODS } from "@/lib/periods";
import { CSV_DIALECTS } from "@/modules/exports/csv";
import { GRANULARITIES } from "@/modules/prices/prices";
import {
  reportCreateSchema,
  reportPreviewSchema,
  reportUpdateSchema,
} from "@/modules/report-definitions/report-definitions.schema";

import type { Operation, QueryParam } from "./registry";
import {
  inflationSchema,
  priceSeriesSchema,
  productsResultSchema,
  reportDefinitionSchema,
  reportRunSchema,
} from "./prices-schemas";
import { dataOf } from "./schemas";

/**
 * Operațiile OpenAPI ale prețurilor, inflației și rapoartelor de micro-cheltuieli (Faza 10,
 * F10-B; ADR 0023). Adăugate la `OPERATIONS` din `registry.ts` printr-o singură linie.
 */

const VALIDATION = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const TOO_LARGE = 413;
const MEDIA = 415;
const REUSED = 422;
const MUTATION_ERRORS = [VALIDATION, FORBIDDEN, TOO_LARGE, MEDIA] as const;

const boolParam = z.enum(["true", "false"]);
const intParam = z.string().regex(/^[0-9]{1,16}$/);
const PATH = "/api/v1/report-definitions";
const BY_ID = `${PATH}/{id}`;
const TAG = "prices";

const THRESHOLDS: readonly QueryParam[] = [
  {
    name: "minObservations",
    schema: intParam,
    description:
      "Numărul minim de linii (observații) pentru ca un produs să aibă rezultate (1–50; implicit 3).",
  },
  {
    name: "minMonths",
    schema: intParam,
    description: "Numărul minim de luni distincte (1–24; implicit 2).",
  },
];

const WINDOW_MONTHS: QueryParam = {
  name: "months",
  schema: intParam,
  description:
    "Fereastra: ultimele N luni calendaristice, inclusiv luna curentă (1–60; implicit 12), în fusul orar al gospodăriei.",
};

const PERIOD: QueryParam = {
  name: "period",
  schema: z.enum(REPORT_PERIODS),
  description:
    "`all` (implicit, toată arhiva), `this_month`, `last_month`, `last_3_months` (luna curentă și cele două dinainte) sau `this_year`; în fusul orar al gospodăriei.",
};

const DIALECT: QueryParam = {
  name: "dialect",
  schema: z.enum(CSV_DIALECTS),
  description:
    "`rfc4180` (implicit: virgulă, punct zecimal) sau `ro` (`;`, virgulă zecimală, pentru Excel în română).",
};

const SOURCE_NOTE =
  "Calculat din liniile de produs ale bonurilor CONFIRMATE vizibile utilizatorului: liniile bonurilor legate de un cont personal al altui membru nu intră. Estimare din bonurile tale, nu un indice oficial.";

export const PRICES_OPERATIONS: readonly Operation[] = [
  {
    method: "GET",
    path: "/api/v1/prices/products",
    operationId: "listProductPrices",
    tag: TAG,
    summary:
      "Produsele cumpărate, cu prețul mediu pe unitate și cel mai ieftin comerciant (doar peste pragul de date).",
    description: `${SOURCE_NOTE} Prețul = media ponderată cu cantitatea, în unități minore pe kg / l / bucată (ambalajele aceluiași produs se compară pe unitate standard) sau pe unitatea de pe bon când numele nu are mărime. Monedele nu se amestecă (un rând pe produs și monedă). Sub pragul de date (\`enough: false\`) toate prețurile sunt \`null\`. Cel mai ieftin comerciant: doar între comercianți cu cel puțin 2 observații, minim doi. Linia cu mărime ambiguă e exclusă (\`excludedLines\`). Peste 100000 de linii în fereastră → 409 \`too_many_lines\`.`,
    query: [
      WINDOW_MONTHS,
      { name: "search", schema: z.string().max(80), description: "Numele conține textul." },
      { name: "currency", schema: z.enum(DB_CURRENCIES), description: "Doar o monedă." },
      { name: "onlyEnough", schema: boolParam, description: "Doar produsele cu date suficiente." },
      { name: "limit", schema: intParam, description: "Produse în răspuns (1–200; implicit 100)." },
      ...THRESHOLDS,
    ],
    success: { status: 200, schema: dataOf(productsResultSchema), description: "Produsele." },
    errors: [VALIDATION, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/prices/series",
    operationId: "getPriceSeries",
    tag: TAG,
    summary: "Evoluția prețului unui produs în timp, generală și pe comerciant.",
    description: `${SOURCE_NOTE} Punctele sunt medii ponderate pe lună (\`YYYY-MM\`) sau pe săptămână (data de luni). Sub pragul de date seriile sunt goale (\`enough: false\`). Produs inexistent în fereastră → 404.`,
    query: [
      {
        name: "product",
        schema: z.string().min(3).max(320),
        description: "`productKey` din lista produselor (`<unitate>|<nume>`).",
      },
      { name: "currency", schema: z.enum(DB_CURRENCIES), description: "Moneda (implicit RON)." },
      {
        name: "granularity",
        schema: z.enum(GRANULARITIES),
        description: "`month` (implicit) sau `week`.",
      },
      WINDOW_MONTHS,
      ...THRESHOLDS,
    ],
    success: { status: 200, schema: dataOf(priceSeriesSchema), description: "Seria." },
    errors: [VALIDATION, NOT_FOUND, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: "/api/v1/inflation",
    operationId: "getPersonalInflation",
    tag: TAG,
    summary: "Inflația personală: variația prețului mediu pe unitate între două perioade.",
    description: `${SOURCE_NOTE} Doar articolele (produs × comerciant) cumpărate în AMBELE perioade, fiecare cu cel puțin 2 observații pe perioadă; agregatul gospodăriei e ponderat cu cheltuiala din perioada de bază și afișat doar peste prag (implicit 5 articole), în puncte de bază (\`changeBps\`). Fereastra curentă = ultimele \`months\` luni (inclusiv luna curentă); baza = \`year_ago\` (același interval cu un an în urmă, implicit) sau \`previous\` (lunile imediat dinainte). Formula: docs/adr/0023-prices-reports.md.`,
    query: [
      {
        name: "months",
        schema: intParam,
        description: "Lungimea ferestrei în luni (1–12; implicit 3).",
      },
      {
        name: "baseline",
        schema: z.enum(INFLATION_BASELINES),
        description: "`year_ago` (implicit) sau `previous`.",
      },
      {
        name: "minObservations",
        schema: intParam,
        description: "Observații minime pe perioadă și articol (1–20; implicit 2).",
      },
      {
        name: "minItems",
        schema: intParam,
        description: "Articole minime pentru agregat (1–50; implicit 5).",
      },
    ],
    success: { status: 200, schema: dataOf(inflationSchema), description: "Inflația." },
    errors: [VALIDATION, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: PATH,
    operationId: "listReportDefinitions",
    tag: "reports",
    summary: "Rapoartele de micro-cheltuieli: cele de sistem (primele) și cele ale gospodăriei.",
    query: [
      { name: "includeArchived", schema: boolParam, description: "Include rapoartele arhivate." },
    ],
    success: {
      status: 200,
      schema: dataOf(z.array(reportDefinitionSchema)),
      description: "Definițiile.",
    },
    errors: [VALIDATION],
  },
  {
    method: "POST",
    path: PATH,
    operationId: "createReportDefinition",
    tag: "reports",
    summary:
      "Creează un raport propriu: reguli de potrivire pe numele normalizat al produselor (include/exclude, `exact`/`prefix`/`contains`/`token`, ȘI/SAU plat).",
    description:
      "Valorile regulilor se normalizează (litere mici, fără diacritice). Cel mult 20 de termeni pe listă; numele unic (fără majuscule) printre rapoartele active (409 `report_name_taken`); cel mult 100 de rapoarte proprii (409 `report_limit`). Categoriile și etichetele din reguli trebuie să existe. Rapoartele de sistem nu se pot crea sau modifica.",
    body: { schema: reportCreateSchema },
    success: {
      status: 201,
      schema: dataOf(reportDefinitionSchema),
      description: "Raportul creat.",
    },
    errors: [...MUTATION_ERRORS, CONFLICT, REUSED],
    idempotent: true,
  },
  {
    method: "POST",
    path: `${PATH}/preview`,
    operationId: "previewReportRules",
    tag: "reports",
    summary: "Previzualizare: rulează regulile din corp pe o perioadă, fără să salveze nimic.",
    description: `Același rezultat ca la rulare, cu \`definition: null\`. Rate limit propriu: 30/min per utilizator. ${SOURCE_NOTE}`,
    body: { schema: reportPreviewSchema },
    success: { status: 200, schema: dataOf(reportRunSchema), description: "Rezultatul." },
    errors: [...MUTATION_ERRORS, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: BY_ID,
    operationId: "getReportDefinition",
    tag: "reports",
    summary: "Un raport (de sistem sau al gospodăriei).",
    success: { status: 200, schema: dataOf(reportDefinitionSchema), description: "Raportul." },
    errors: [VALIDATION, NOT_FOUND],
  },
  {
    method: "PATCH",
    path: BY_ID,
    operationId: "patchReportDefinition",
    tag: "reports",
    summary: "Modifică sau arhivează un raport propriu (cele de sistem: 403).",
    body: { schema: reportUpdateSchema },
    success: { status: 200, schema: dataOf(reportDefinitionSchema), description: "Raportul." },
    errors: [...MUTATION_ERRORS, NOT_FOUND, CONFLICT],
  },
  {
    method: "DELETE",
    path: BY_ID,
    operationId: "deleteReportDefinition",
    tag: "reports",
    summary: "Șterge un raport propriu (cele de sistem: 403).",
    success: { status: 204, schema: null, description: "Șters." },
    errors: [FORBIDDEN, NOT_FOUND, MEDIA],
  },
  {
    method: "GET",
    path: `${BY_ID}/run`,
    operationId: "runReportDefinition",
    tag: "reports",
    summary:
      "Rulează raportul pe o perioadă: total, bucăți, preț mediu pe unitate, proiecție anuală (estimare), istoricul liniilor.",
    description: `${SOURCE_NOTE} Totalul = plătit − reduceri (la rapoartele doar de reduceri: suma reducerilor). Proiecția anuală = total · 365 / zilele dintre primul și ultimul bon confirmat vizibil din perioadă; sub 60 de zile sau 10 bonuri: \`status: insufficient\`. Istoricul: cele mai noi 200 de linii (\`linesTruncated\`), cu \`receiptId\` pentru legătura la bon. Rate limit propriu: 30/min per utilizator. Peste 100000 de linii în perioadă → 409 \`too_many_lines\`.`,
    query: [PERIOD],
    success: { status: 200, schema: dataOf(reportRunSchema), description: "Rezultatul." },
    errors: [VALIDATION, NOT_FOUND, CONFLICT, REUSED],
  },
  {
    method: "GET",
    path: `${BY_ID}/export.csv`,
    operationId: "exportReportDefinitionCsv",
    tag: "exports",
    summary: "Exportul CSV al liniilor potrivite de raport (toate, nu doar istoricul din ecran).",
    query: [PERIOD, DIALECT],
    success: {
      status: 200,
      schema: null,
      csv: true,
      description:
        "Fișierul `finet-raport.csv`. UTF-8 cu BOM, CRLF, ghilimele RFC 4180; celulele de text liber care încep cu = + - @ TAB CR primesc un apostrof. Antete: `Content-Disposition: attachment` (nume fix), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Rate limit propriu: 10/min per utilizator.",
    },
    errors: [VALIDATION, FORBIDDEN, NOT_FOUND, CONFLICT, REUSED],
  },
];
