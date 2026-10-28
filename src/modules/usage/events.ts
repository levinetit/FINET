import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { type DbOrTx, withRlsOn } from "@/db";
import { appEvents, clientInstallations } from "@/db/schema";
import { ValidationError } from "@/lib/errors";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import type { ClientInfo } from "@/modules/auth/request";
import { parseInput } from "@/modules/ledger/input";

import {
  EVENTS_REJECTED_MESSAGE,
  EVENT_MAX_AGE_MS,
  EVENT_MAX_SKEW_MS,
  appEventsBatchSchema,
} from "./usage.schema";

import { hasActiveConsent, lockUserUsage } from "./consents";

/**
 * Evenimentele de utilizare (6.5, Android 10.1): `POST /api/v1/app/events`. Lista de nume,
 * ecrane și coduri de eroare e FIXĂ; fiecare eveniment are DOAR `name`, `screen?`, `errorCode?`,
 * `occurredAt` (Zod strict): orice alt câmp (o sumă, o descriere, un comerciant) respinge tot
 * lotul cu 400 și mesaj fix, fără ecoul valorii. Ordinea: validare → consimțământ → stocare; fără
 * consimțământ `usage_stats` activ, nimic nu se stochează (răspunsul e același, 204).
 */

export type RecordEventsResult = Readonly<{ stored: number }>;

export async function recordEvents(
  db: DbOrTx,
  userId: string,
  rawInput: unknown,
  client: ClientInfo | null,
  now: number,
): Promise<RecordEventsResult> {
  let input: z.output<typeof appEventsBatchSchema>;
  try {
    input = parseInput(appEventsBatchSchema, rawInput);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(error.fields, EVENTS_REJECTED_MESSAGE);
    }
    throw error;
  }
  const fields: Record<string, string> = {};
  input.events.forEach((e, i) => {
    const t = Date.parse(e.occurredAt);
    if (t < now - EVENT_MAX_AGE_MS || t > now + EVENT_MAX_SKEW_MS) {
      fields[`events.${i}.occurredAt`] = "Momentul e în afara intervalului acceptat.";
    }
  });
  if (Object.keys(fields).length > 0) throw new ValidationError(fields, EVENTS_REJECTED_MESSAGE);

  return withRlsOn(db, { userId }, async (tx) => {
    // Serializat cu revocarea (LOW-1): un lot în curs nu supraviețuiește ștergerii datelor.
    await lockUserUsage(tx, userId);
    if (!(await hasActiveConsent(tx, userId, "usage_stats"))) return { stored: 0 };
    const householdId = await currentHouseholdIdOf(tx, userId);
    if (householdId) {
      await tx.execute(sql`select set_config('app.household_id', ${householdId}, true)`);
    }
    // Instalarea se leagă doar dacă e una a utilizatorului curent (altfel RLS ar respinge tot).
    let installationId: string | null = null;
    if (client) {
      const rows = await tx
        .select({ id: clientInstallations.installationId })
        .from(clientInstallations)
        .where(
          and(
            eq(clientInstallations.userId, userId),
            eq(clientInstallations.installationId, client.installationId),
          ),
        )
        .limit(1);
      installationId = rows[0]?.id ?? null;
    }
    await tx.insert(appEvents).values(
      input.events.map((e) => ({
        userId,
        householdId,
        installationId,
        name: e.name,
        screen: e.screen ?? null,
        errorCode: e.errorCode ?? null,
        appVersion: client?.appVersion ?? null,
        occurredAt: new Date(e.occurredAt),
      })),
    );
    return { stored: input.events.length };
  });
}
