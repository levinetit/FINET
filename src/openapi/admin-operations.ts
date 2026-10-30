import { z } from "zod";

import {
  ANNOUNCEMENT_LEVELS,
  APP_ERROR_KINDS,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
} from "@/db/schema/admin";
import {
  announcementCreateSchema,
  announcementUpdateSchema,
  errorReportSchema,
  feedbackCreateSchema,
  feedbackStatusSchema,
  userStatusSchema,
} from "@/modules/admin/admin.schema";

import type { Operation, QueryParam } from "./registry";
import { dataOf } from "./schemas";

/**
 * Operațiile OpenAPI ale feedback-ului, anunțurilor, raportării erorilor și panoului de
 * administrare (Faza 11-B, ADR 0028). TOATE există doar în modul `saas` (în `personal`: 404);
 * rutele `/admin/*` răspund 404 și non-administratorilor.
 */

const SAAS = "Doar modul `saas`: în `personal` răspunde 404. ";
const ADMIN =
  "Doar administratorul platformei: orice alt utilizator primește 404 (nu se dezvăluie panoul); fără date financiare. ";
const uuid = z.uuid();
const instant = z.iso.datetime();

const page: readonly QueryParam[] = [
  { name: "limit", schema: z.string().regex(/^[0-9]{1,3}$/), description: "1–200 (implicit 50)." },
  { name: "offset", schema: z.string().regex(/^[0-9]{1,7}$/), description: "Implicit 0." },
];

const announcement = z.strictObject({
  id: uuid,
  title: z.string(),
  body: z.string(),
  level: z.enum(ANNOUNCEMENT_LEVELS),
  startsAt: instant,
  endsAt: instant.nullable(),
});

const idPath = "/{id}";

export const ADMIN_OPERATIONS: readonly Operation[] = [
  {
    method: "POST",
    path: "/api/v1/feedback",
    operationId: "createFeedback",
    tag: "feedback",
    summary: "Trimite feedback sau raportează un bug (text liber, fără date financiare).",
    description: `${SAAS}Mesajul are 3–2000 de caractere; \`page\` e doar ruta (fără parametri). Fără \`userId\` în corp: autorul e utilizatorul sesiunii. Se șterge odată cu contul.`,
    body: { schema: feedbackCreateSchema },
    success: { status: 201, schema: dataOf(z.strictObject({ id: uuid })), description: "Creat." },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "GET",
    path: "/api/v1/announcements",
    operationId: "listAnnouncements",
    tag: "feedback",
    summary: "Anunțurile active ale administratorului (cel mult 5).",
    description: `${SAAS}`,
    success: { status: 200, schema: dataOf(z.array(announcement)), description: "Anunțurile." },
    errors: [400, 404],
  },
  {
    method: "POST",
    path: "/api/v1/errors",
    operationId: "reportError",
    tag: "feedback",
    summary: "Raportează o eroare a interfeței (rută, cod, digest); fără mesaje sau date.",
    description: `${SAAS}Valorile care nu respectă formele se ignoră (204 oricum); cel mult 500 de erori distincte se păstrează.`,
    body: { schema: errorReportSchema },
    success: { status: 204, schema: null, description: "Primit." },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "GET",
    path: "/api/v1/admin/users",
    operationId: "adminListUsers",
    tag: "admin",
    summary: "Utilizatorii platformei (id, email, nume, stare, număr de gospodării).",
    description: `${SAAS}${ADMIN}`,
    query: page,
    success: {
      status: 200,
      schema: dataOf(
        z.array(
          z.strictObject({
            id: uuid,
            email: z.string(),
            name: z.string(),
            status: z.enum(["active", "disabled"]),
            isPlatformAdmin: z.boolean(),
            createdAt: instant,
            households: z.number().int(),
          }),
        ),
      ),
      description: "Utilizatorii.",
    },
    errors: [400, 404],
  },
  {
    method: "PATCH",
    path: `/api/v1/admin/users${idPath}`,
    operationId: "adminSetUserStatus",
    tag: "admin",
    summary: "Activează sau dezactivează un cont (nu pe al tău).",
    description: `${SAAS}${ADMIN}Un cont dezactivat nu mai are sesiune validă. Se auditează (țintă și stare, fără conținut).`,
    body: { schema: userStatusSchema },
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ changed: z.boolean() })),
      description: "Schimbat.",
    },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "GET",
    path: "/api/v1/admin/households",
    operationId: "adminListHouseholds",
    tag: "admin",
    summary: "Gospodăriile (id, nume, număr de membri).",
    description: `${SAAS}${ADMIN}`,
    query: page,
    success: {
      status: 200,
      schema: dataOf(
        z.array(
          z.strictObject({
            id: uuid,
            name: z.string(),
            members: z.number().int(),
            createdAt: instant,
          }),
        ),
      ),
      description: "Gospodăriile.",
    },
    errors: [400, 404],
  },
  {
    method: "GET",
    path: "/api/v1/admin/jobs",
    operationId: "adminListJobs",
    tag: "admin",
    summary: "Cozile de lucru: numele jobului, starea și numărul (fără conținut).",
    description: `${SAAS}${ADMIN}`,
    success: {
      status: 200,
      schema: dataOf(
        z.array(z.strictObject({ name: z.string(), state: z.string(), jobs: z.number().int() })),
      ),
      description: "Cozile.",
    },
    errors: [400, 404],
  },
  {
    method: "GET",
    path: "/api/v1/admin/feedback",
    operationId: "adminListFeedback",
    tag: "admin",
    summary: "Feedback-ul și bug-urile raportate (cu emailul autorului).",
    description: `${SAAS}${ADMIN}`,
    query: [
      ...page,
      { name: "status", schema: z.enum(FEEDBACK_STATUSES), description: "Filtru pe stare." },
    ],
    success: {
      status: 200,
      schema: dataOf(
        z.array(
          z.strictObject({
            id: uuid,
            kind: z.enum(FEEDBACK_KINDS),
            message: z.string(),
            page: z.string().nullable(),
            appVersion: z.string().nullable(),
            status: z.enum(FEEDBACK_STATUSES),
            createdAt: instant,
            authorEmail: z.string(),
          }),
        ),
      ),
      description: "Feedback-ul.",
    },
    errors: [400, 404],
  },
  {
    method: "PATCH",
    path: `/api/v1/admin/feedback${idPath}`,
    operationId: "adminSetFeedbackStatus",
    tag: "admin",
    summary: "Schimbă starea unui feedback (nou / văzut / închis).",
    description: `${SAAS}${ADMIN}Se auditează.`,
    body: { schema: feedbackStatusSchema },
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ id: uuid, status: z.enum(FEEDBACK_STATUSES) })),
      description: "Schimbat.",
    },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "GET",
    path: "/api/v1/admin/announcements",
    operationId: "adminListAnnouncements",
    tag: "admin",
    summary: "Toate anunțurile (cel mult 100), inclusiv cele arhivate.",
    description: `${SAAS}${ADMIN}`,
    success: {
      status: 200,
      schema: dataOf(z.array(announcement.extend({ archived: z.boolean() }))),
      description: "Anunțurile.",
    },
    errors: [400, 404],
  },
  {
    method: "POST",
    path: "/api/v1/admin/announcements",
    operationId: "adminCreateAnnouncement",
    tag: "admin",
    summary: "Creează un anunț (titlu ≤ 100, text ≤ 500, nivel info/warn, perioadă opțională).",
    description: `${SAAS}${ADMIN}Se auditează.`,
    body: { schema: announcementCreateSchema },
    success: { status: 201, schema: dataOf(announcement), description: "Creat." },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "PATCH",
    path: `/api/v1/admin/announcements${idPath}`,
    operationId: "adminUpdateAnnouncement",
    tag: "admin",
    summary: "Modifică sau arhivează un anunț.",
    description: `${SAAS}${ADMIN}Se auditează.`,
    body: { schema: announcementUpdateSchema },
    success: { status: 200, schema: dataOf(announcement), description: "Modificat." },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "GET",
    path: "/api/v1/admin/errors",
    operationId: "adminListErrors",
    tag: "admin",
    summary: "Erorile raportate (tip, rută, cod, digest, apariții); fără mesaje sau stive.",
    description: `${SAAS}${ADMIN}`,
    success: {
      status: 200,
      schema: dataOf(
        z.array(
          z.strictObject({
            kind: z.enum(APP_ERROR_KINDS),
            route: z.string(),
            code: z.string(),
            digest: z.string().nullable(),
            appVersion: z.string().nullable(),
            occurrences: z.number().int(),
            firstSeenAt: instant,
            lastSeenAt: instant,
          }),
        ),
      ),
      description: "Erorile.",
    },
    errors: [400, 404],
  },
];
