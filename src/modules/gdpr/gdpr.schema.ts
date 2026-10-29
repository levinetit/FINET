import { z } from "zod";

/**
 * Schemele GDPR (Faza 9, F9-B, ADR 0021), fără dependențe de server: le folosesc serviciile,
 * API-ul, UI-ul și generatorul OpenAPI.
 */

/** Textul de confirmare scris de utilizator (exact, cu diacritice). */
export const DELETE_CONFIRMATION = "ȘTERGE";

/** Lungimea maximă a parolei acceptate la reautentificare (aceeași ca politica, F1). */
const PASSWORD_MAX = 256;

export const deleteAccountSchema = z.strictObject({
  /** Parola curentă (obligatorie pentru conturile cu parolă). */
  password: z.string().min(1, "Scrie parola.").max(PASSWORD_MAX, "Parola e prea lungă.").optional(),
  confirm: z.literal(DELETE_CONFIRMATION, "Scrie exact ȘTERGE."),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;

export type DeletionHousehold = Readonly<{ id: string; name: string }>;

/** Ce se întâmplă la ștergere (`GET /api/v1/me/deletion`), fără sume sau date financiare. */
export type DeletionPreview = Readonly<{
  /** Contul are parolă (altfel reautentificarea = o sesiune proaspătă). */
  hasPassword: boolean;
  /** Administratorul platformei: ștergerea din aplicație e refuzată. */
  platformAdmin: boolean;
  /** Gospodăriile în care e singurul membru: se șterg cu TOATE datele și fișierele lor. */
  deletedHouseholds: DeletionHousehold[];
  /** Gospodăriile cu alți membri din care iese; `unsettled` = are solduri nedecontate acolo. */
  leftHouseholds: (DeletionHousehold & Readonly<{ unsettled: boolean }>)[];
  /** Gospodăriile în care e ultimul proprietar, cu alți membri: ștergerea e blocată. */
  blockedHouseholds: DeletionHousehold[];
}>;

export type DeletionResult = Readonly<{
  /** `deleted` = rândul utilizatorului a dispărut; `anonymized` = păstrat anonim (istoric). */
  outcome: "deleted" | "anonymized";
  deletedHouseholds: number;
  leftHouseholds: number;
}>;

// --- Schemele răspunsurilor (OpenAPI și contractul testat) ------------------------------------

const householdRef = z.strictObject({ id: z.uuid(), name: z.string() });

export const deletionPreviewSchema = z.strictObject({
  hasPassword: z.boolean(),
  platformAdmin: z.boolean(),
  deletedHouseholds: z.array(householdRef),
  leftHouseholds: z.array(householdRef.extend({ unsettled: z.boolean() })),
  blockedHouseholds: z.array(householdRef),
});

export const deletionResultSchema = z.strictObject({
  outcome: z.enum(["deleted", "anonymized"]),
  deletedHouseholds: z.number().int(),
  leftHouseholds: z.number().int(),
});
