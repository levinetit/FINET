import { z } from "zod";

import type { DOCUMENT_KINDS, DOCUMENT_MIMES, DOCUMENT_STATUSES } from "@/db/schema";

/**
 * Formele publice ale documentelor (serviciul + API-ul din F6-C). Câmpurile text ale încărcării
 * vin din `multipart/form-data`, deci sunt șiruri.
 */

/** Câmpurile text ale încărcării: tipul (doar bonuri în Faza 6) și modul „bon lung”. */
export const uploadFieldsSchema = z.strictObject({
  kind: z.enum(["receipt", "statement"]).optional(),
  longReceipt: z.enum(["true", "false"]).optional(),
});
export type UploadFields = z.infer<typeof uploadFieldsSchema>;

export type DocumentView = Readonly<{
  id: string;
  kind: (typeof DOCUMENT_KINDS)[number];
  status: (typeof DOCUMENT_STATUSES)[number];
  mime: (typeof DOCUMENT_MIMES)[number];
  sizeBytes: number;
  pages: number | null;
  batchId: string | null;
  documentOrder: number | null;
  possibleDuplicateOfId: string | null;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  /** Fișierul original a fost șters la expirarea retenției (datele extrase rămân). */
  fileDeleted: boolean;
}>;

export type UploadedDocument = DocumentView &
  Readonly<{
    /** `true` dacă fișierul exista deja (SHA-256 identic): nu s-a creat un document nou. */
    duplicate: boolean;
  }>;

export type UploadResult = Readonly<{
  documents: readonly UploadedDocument[];
  /** Lotul bonului lung (2–4 poze), dacă e cazul. */
  batchId: string | null;
  /** Documente noi create (fără duplicate); ce se numără la limita zilnică. */
  created: number;
}>;

export type DailyUsage = Readonly<{ used: number; limit: number }>;
