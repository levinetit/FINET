import { z } from "zod";

import { completeInputSchema, registerInputSchema } from "@/modules/auth/registration";

import type { Operation } from "./registry";
import { dataOf } from "./schemas";

/**
 * Operațiile OpenAPI ale înregistrării publice (Faza 11-C, ADR 0029). RUTE FĂRĂ SESIUNE (nu cer
 * cookie sau bearer; 401 nu se întoarce niciodată), protejate prin `Origin` (CSRF) și rate limiting
 * pe IP și email. Există doar în modul `saas`, cu `SIGNUP_ENABLED=1` și SMTP configurat; altfel 404.
 */

const GATE =
  "Fără sesiune. Doar modul `saas` cu `SIGNUP_ENABLED=1` și SMTP configurat: altfel 404. Cererea de pe alt `Origin` primește 403. ";

export const REGISTER_OPERATIONS: readonly Operation[] = [
  {
    method: "POST",
    path: "/api/v1/register",
    operationId: "registerAccount",
    tag: "register",
    summary: "Începe înregistrarea: email, nume și acceptarea termenilor (pasul 1 din 2).",
    description: `${GATE}Răspunsul (202) este IDENTIC indiferent dacă adresa are deja cont: pentru o adresă nouă (sau neconfirmată) se trimite emailul cu linkul de confirmare, pentru una cu cont se trimite un mesaj „ai deja un cont”. Parola NU se trimite aici: o alege proprietarul adresei în pasul 2. Primul utilizator al unei platforme noi NU devine administrator pe această cale.`,
    body: { schema: registerInputSchema },
    success: {
      status: 202,
      schema: dataOf(z.strictObject({ status: z.literal("pending") })),
      description: "Primit; emailul se trimite în fundal.",
    },
    errors: [400, 403, 404, 413, 415],
  },
  {
    method: "POST",
    path: "/api/v1/register/complete",
    operationId: "completeRegistration",
    tag: "register",
    summary: "Termină înregistrarea: linkul din email și parola aleasă (pasul 2 din 2).",
    description: `${GATE}Linkul e semnat, expiră în 48 de ore și se folosește o singură dată. Parola respectă politica (10–128 de caractere, HIBP dacă e activat); o parolă respinsă (400, cod \`password\`) NU consumă linkul. Un link invalid, expirat sau deja folosit răspunde 410 (cod \`invalid_token\`).`,
    body: { schema: completeInputSchema },
    success: {
      status: 200,
      schema: dataOf(z.strictObject({ status: z.literal("verified") })),
      description: "Emailul e confirmat și parola setată.",
    },
    errors: [400, 403, 404, 410, 413, 415],
  },
];
