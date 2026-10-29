import "server-only";

import {
  type SQL,
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sum,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { type Db, type Tx, withRlsOn } from "@/db";
import {
  accounts,
  appEvents,
  auditEvents,
  authAccounts,
  authSessions,
  budgets,
  categories,
  clientInstallations,
  consents,
  documents,
  goals,
  householdMembers,
  households,
  receiptLines,
  receipts,
  recurringRules,
  settlements,
  statementImports,
  statementLines,
  tags,
  transactionSplits,
  transactionTags,
  transactions,
  userPreferences,
  users,
} from "@/db/schema";
import { type Storage, isKeyOfHousehold } from "@/lib/storage";
import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, type ZipEntryOptions, type ZipSource } from "@/lib/zip";
import { insertAudit } from "@/modules/auth/audit";
import { exportTransactionsCsv } from "@/modules/exports/exports.service";

/**
 * Exportul GDPR al contului (master prompt 6.3 „export complet (JSON, CSV și fișierele
 * originale)”; F9-B, ADR 0021), ca intrări pentru `zipStream` (arhiva se produce în flux).
 *
 * VIZIBILITATEA (regula de bază): fiecare interogare rulează ca `finet_app`, sub RLS-ul
 * UTILIZATORULUI, gospodărie cu gospodărie: conturile personale ale altor membri și tot ce derivă
 * din ele (tranzacții, etichete, reguli recurente) NU apar, exact ca în aplicație. În plus, filtre
 * explicite (decizia mea): împărțirile și decontările doar cele în care e parte, evenimentele de
 * audit doar cele în care e actor, documentele (și pozele) doar cele încărcate de el; membrii
 * gospodăriei doar cu id și rol (fără numele altora).
 *
 * NU se exportă: tokenuri de sesiune, hash-ul parolei, tokenuri OAuth, hash-urile invitațiilor,
 * cheile `Idempotency-Key` (răspunsuri memorate), cheile de storage, jurnalul AI.
 *
 * Memoria: tabelele mari (tranzacții, evenimente) se citesc pe pagini; pozele se copiază în flux
 * din storage. Exportul NU e un instantaneu atomic (o scriere în timpul exportului poate apărea
 * sau nu); fiecare secțiune e consistentă în sine.
 */

export type ExportDeps = Readonly<{ db: Db; storage: Storage; now?: () => Date }>;
export type ZipEntry = readonly [string, ZipSource, ZipEntryOptions?];

export const EXPORT_PAGE = 1000;

/** JSON fără pierderi: bigint → număr (sub 2^53, plafonul sumelor e 1e13) sau șir; Date → ISO. */
export function exportJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (typeof v === "bigint") {
        return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(v)
          : v.toString();
      }
      return v;
    },
    2,
  );
}

/** Un tablou JSON produs pe pagini (fără a ține tot în memorie). */
async function* jsonPages<T extends { id: string }>(
  page: (after: string | null) => Promise<T[]>,
): AsyncGenerator<Uint8Array> {
  yield Buffer.from("[");
  let after: string | null = null;
  let first = true;
  for (;;) {
    const rows = await page(after);
    if (rows.length === 0) break;
    let chunk = "";
    for (const r of rows) {
      chunk += (first ? "\n" : ",\n") + exportJson(r);
      first = false;
    }
    yield Buffer.from(chunk);
    if (rows.length < EXPORT_PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  yield Buffer.from(first ? "]\n" : "\n]\n");
}

// --- Verificarea dinaintea exportului (revizuirea F9) ---------------------------------------

/** Intrările fixe: `README.txt`, `profil.json` și cele 15 fișiere de pe fiecare gospodărie. */
export const FIXED_ENTRIES = 2;
export const ENTRIES_PER_HOUSEHOLD = 15;
/** Estimarea pe tranzacție (JSON + CSV, necomprimat) și rezerva pentru restul textului. */
export const BYTES_PER_TRANSACTION = 4096;
export const TEXT_RESERVE_BYTES = 64 * 1024 * 1024;

export type ExportLimits = Readonly<{ maxBytes: number; maxEntries: number }>;
export const DEFAULT_EXPORT_LIMITS: ExportLimits = Object.freeze({
  maxBytes: ZIP_MAX_BYTES,
  maxEntries: ZIP_MAX_ENTRIES,
});

export type ExportEstimate = Readonly<{ entries: number; bytes: number }>;

/** Exportul nu încape în limitele ZIP (fără ZIP64): 413 cu cod fix, ÎNAINTE de flux. */
export class ExportTooLargeError extends Error {
  constructor() {
    super("Exportul depășește dimensiunea maximă a unei arhive.");
    this.name = "ExportTooLargeError";
  }
}

/**
 * Estimarea arhivei, sub RLS-ul utilizatorului (aceleași filtre ca exportul): fișierele bonurilor
 * lui (`size_bytes`, doar cele cu fișier) și tranzacțiile vizibile, gospodărie cu gospodărie.
 * Supraestimează textul (prag sigur), nu citește conținut.
 */
export async function estimateExport(db: Db, userId: string): Promise<ExportEstimate> {
  const memberships = await inUser(db, userId, (tx) =>
    tx
      .select({ id: householdMembers.householdId })
      .from(householdMembers)
      .where(eq(householdMembers.userId, userId)),
  );
  let entries = FIXED_ENTRIES;
  let bytes = TEXT_RESERVE_BYTES;
  for (const { id: hh } of memberships) {
    const r = await inHh(db, userId, hh, async (tx) => {
      const [d] = await tx
        .select({ n: count(), size: sum(documents.sizeBytes) })
        .from(documents)
        .where(
          and(
            eq(documents.householdId, hh),
            eq(documents.uploadedByUserId, userId),
            isNotNull(documents.storageKey),
            isNull(documents.fileDeletedAt),
          ),
        );
      const [t] = await tx
        .select({ n: count() })
        .from(transactions)
        .where(eq(transactions.householdId, hh));
      return { files: Number(d?.n ?? 0), fileBytes: Number(d?.size ?? 0), tx: Number(t?.n ?? 0) };
    });
    entries += ENTRIES_PER_HOUSEHOLD + r.files;
    bytes += r.fileBytes + r.tx * BYTES_PER_TRANSACTION;
  }
  return { entries, bytes };
}

export function assertExportFits(
  e: ExportEstimate,
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): void {
  if (e.entries > limits.maxEntries || e.bytes > limits.maxBytes) throw new ExportTooLargeError();
}

const README = (n: number) => `Exportul datelor tale din FINET

Arhiva conține datele contului tău, în format JSON (și tranzacțiile și în CSV), plus fișierele
originale ale bonurilor încărcate de tine.

- profil.json: profilul, preferințele, consimțămintele, sesiunile (fără tokenuri), metodele de
  autentificare (fără parolă), instalările și evenimentele de utilizare.
- gospodarii/<n>/: câte un dosar pentru fiecare dintre cele ${n} gospodării din care faci parte:
  gospodăria, conturile, categoriile, etichetele, tranzacțiile (JSON și CSV), bugetele, obiectivele,
  regulile recurente, bonurile încărcate de tine (cu liniile lor), importurile de extrase făcute de
  tine (cu rândurile lor; fișierele extraselor nu se păstrează), împărțirile și decontările în
  care ești parte, acțiunile tale din jurnalul de audit și fișierele bonurilor (fisiere/).

Exportul conține doar ce poți vedea în aplicație: conturile personale ale altor membri nu apar.
Sumele sunt în unități minore (bani), ca numere întregi (de exemplu 1234 = 12,34 lei).
`;

function inUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>) {
  return withRlsOn(db, { userId }, fn);
}
function inHh<T>(db: Db, userId: string, householdId: string, fn: (tx: Tx) => Promise<T>) {
  return withRlsOn(db, { userId, householdId }, fn);
}

async function profile(db: Db, userId: string) {
  return inUser(db, userId, async (tx) => {
    const [user] = await tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    const [preferences] = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId));
    return {
      user,
      preferences: preferences ?? null,
      consents: await tx
        .select({
          kind: consents.kind,
          grantedAt: consents.grantedAt,
          revokedAt: consents.revokedAt,
        })
        .from(consents)
        .where(eq(consents.userId, userId))
        .orderBy(asc(consents.grantedAt)),
      sessions: await tx
        .select({
          createdAt: authSessions.createdAt,
          updatedAt: authSessions.updatedAt,
          expiresAt: authSessions.expiresAt,
          ipAddress: authSessions.ipAddress,
          userAgent: authSessions.userAgent,
        })
        .from(authSessions)
        .where(eq(authSessions.userId, userId))
        .orderBy(asc(authSessions.createdAt)),
      authMethods: await tx
        .select({ providerId: authAccounts.providerId, createdAt: authAccounts.createdAt })
        .from(authAccounts)
        .where(eq(authAccounts.userId, userId)),
      installations: await tx
        .select()
        .from(clientInstallations)
        .where(eq(clientInstallations.userId, userId)),
    };
  });
}

/** Toate rândurile unui tabel mic al gospodăriei (sub RLS-ul utilizatorului). */
function rowsOf(db: Db, userId: string, hh: string, table: PgTable, where: SQL | undefined) {
  return inHh(db, userId, hh, (tx) =>
    tx
      .select()
      .from(table)
      .where(where)
      .orderBy(asc((table as unknown as { id: typeof accounts.id }).id)),
  );
}

const EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * Intrările arhivei, în ordine. Auditul („export cerut”, fără conținut) se scrie la început, în
 * gospodăria curentă a utilizatorului.
 */
export async function* dataExportEntries(
  deps: ExportDeps,
  userId: string,
  auditHouseholdId: string | null,
): AsyncGenerator<ZipEntry> {
  const { db } = deps;
  const memberships = await inUser(db, userId, (tx) =>
    tx
      .select({ id: householdMembers.householdId, role: householdMembers.role })
      .from(householdMembers)
      .where(eq(householdMembers.userId, userId))
      .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.householdId)),
  );
  if (auditHouseholdId) {
    await inHh(db, userId, auditHouseholdId, (tx) =>
      insertAudit(tx, userId, auditHouseholdId, {
        action: "user.data_exported",
        targetType: "user",
        targetId: userId,
        metadata: { households: memberships.length },
      }),
    );
  }

  yield ["README.txt", README(memberships.length)];
  const p = await profile(db, userId);
  async function* profileJson(): AsyncGenerator<Uint8Array> {
    const head = exportJson(p);
    // Evenimentele de utilizare pot fi multe: pe pagini, în același obiect.
    yield Buffer.from(`${head.slice(0, -2)},\n  "appEvents": `);
    yield* jsonPages((after) =>
      inUser(db, userId, (tx) =>
        tx
          .select()
          .from(appEvents)
          .where(and(eq(appEvents.userId, userId), after ? gt(appEvents.id, after) : undefined))
          .orderBy(asc(appEvents.id))
          .limit(EXPORT_PAGE),
      ),
    );
    yield Buffer.from("}\n");
  }
  yield ["profil.json", profileJson()];

  for (const [i, m] of memberships.entries()) {
    const dir = `gospodarii/${i + 1}`;
    const hh = m.id;
    const household = await inHh(db, userId, hh, async (tx) => {
      const [h] = await tx.select().from(households).where(eq(households.id, hh));
      const members = await tx
        .select({
          userId: householdMembers.userId,
          role: householdMembers.role,
          joinedAt: householdMembers.joinedAt,
        })
        .from(householdMembers)
        .where(eq(householdMembers.householdId, hh))
        .orderBy(asc(householdMembers.joinedAt));
      return {
        household: h,
        myRole: m.role,
        members: members.map((x) => ({ ...x, isMe: x.userId === userId })),
      };
    });
    yield [`${dir}/gospodarie.json`, exportJson(household)];
    yield [
      `${dir}/conturi.json`,
      exportJson(await rowsOf(db, userId, hh, accounts, eq(accounts.householdId, hh))),
    ];
    yield [
      `${dir}/categorii.json`,
      exportJson(await rowsOf(db, userId, hh, categories, eq(categories.householdId, hh))),
    ];
    yield [
      `${dir}/etichete.json`,
      exportJson(await rowsOf(db, userId, hh, tags, eq(tags.householdId, hh))),
    ];
    yield [
      `${dir}/tranzactii.json`,
      jsonPages((after) =>
        inHh(db, userId, hh, (tx) =>
          tx
            .select()
            .from(transactions)
            .where(
              and(eq(transactions.householdId, hh), after ? gt(transactions.id, after) : undefined),
            )
            .orderBy(asc(transactions.id))
            .limit(EXPORT_PAGE),
        ),
      ),
    ];
    yield [
      `${dir}/tranzactii.csv`,
      (async function* () {
        for await (const chunk of exportTransactionsCsv(
          { db },
          { userId },
          hh,
          {},
          {
            maxRows: Number.MAX_SAFE_INTEGER,
          },
        )) {
          yield Buffer.from(chunk);
        }
      })(),
    ];
    yield [
      `${dir}/etichete-tranzactii.json`,
      exportJson(
        await inHh(db, userId, hh, (tx) =>
          tx.select().from(transactionTags).where(eq(transactionTags.householdId, hh)),
        ),
      ),
    ];
    yield [
      `${dir}/bugete.json`,
      exportJson(await rowsOf(db, userId, hh, budgets, eq(budgets.householdId, hh))),
    ];
    yield [
      `${dir}/obiective.json`,
      exportJson(await rowsOf(db, userId, hh, goals, eq(goals.householdId, hh))),
    ];
    yield [
      `${dir}/recurente.json`,
      exportJson(await rowsOf(db, userId, hh, recurringRules, eq(recurringRules.householdId, hh))),
    ];

    // Bonurile încărcate de el: documentele (fără cheia de storage), bonurile, liniile.
    const docs = await inHh(db, userId, hh, (tx) =>
      tx
        .select()
        .from(documents)
        .where(and(eq(documents.householdId, hh), eq(documents.uploadedByUserId, userId)))
        .orderBy(asc(documents.id)),
    );
    const docIds = docs.map((d) => d.id);
    const receiptRows =
      docIds.length === 0
        ? []
        : await inHh(db, userId, hh, (tx) =>
            tx
              .select()
              .from(receipts)
              .where(and(eq(receipts.householdId, hh), inArray(receipts.documentId, docIds)))
              .orderBy(asc(receipts.id)),
          );
    const receiptIds = receiptRows.map((r) => r.id);
    const lines =
      receiptIds.length === 0
        ? []
        : await inHh(db, userId, hh, (tx) =>
            tx
              .select()
              .from(receiptLines)
              .where(
                and(eq(receiptLines.householdId, hh), inArray(receiptLines.receiptId, receiptIds)),
              )
              .orderBy(asc(receiptLines.receiptId), asc(receiptLines.position)),
          );
    yield [
      `${dir}/bonuri.json`,
      exportJson({
        documents: docs.map(({ storageKey, ...rest }) => ({
          ...rest,
          file:
            rest.fileDeletedAt === null && storageKey
              ? `fisiere/${rest.id}.${EXT[rest.detectedMime] ?? "bin"}`
              : null,
        })),
        receipts: receiptRows,
        lines,
      }),
    ];
    // Faza 7: importurile de extras create de el (fără fișiere: PDF-urile sunt temporare) și
    // rândurile lor (sub RLS: conturile personale ale altora nu apar).
    const imports = await inHh(db, userId, hh, (tx) =>
      tx
        .select()
        .from(statementImports)
        .where(
          and(eq(statementImports.householdId, hh), eq(statementImports.createdByUserId, userId)),
        )
        .orderBy(asc(statementImports.id)),
    );
    const importIds = imports.map((i) => i.id);
    yield [
      `${dir}/extrase.json`,
      exportJson({
        imports,
        lines:
          importIds.length === 0
            ? []
            : await inHh(db, userId, hh, (tx) =>
                tx
                  .select()
                  .from(statementLines)
                  .where(
                    and(
                      eq(statementLines.householdId, hh),
                      inArray(statementLines.importId, importIds),
                    ),
                  )
                  .orderBy(asc(statementLines.importId), asc(statementLines.rowNo)),
              ),
      }),
    ];
    yield [
      `${dir}/impartiri.json`,
      exportJson(
        await inHh(db, userId, hh, (tx) =>
          tx
            .select()
            .from(transactionSplits)
            .where(
              and(
                eq(transactionSplits.householdId, hh),
                or(eq(transactionSplits.userId, userId), eq(transactionSplits.payerUserId, userId)),
              ),
            )
            .orderBy(asc(transactionSplits.id)),
        ),
      ),
    ];
    yield [
      `${dir}/decontari.json`,
      exportJson(
        await inHh(db, userId, hh, (tx) =>
          tx
            .select()
            .from(settlements)
            .where(
              and(
                eq(settlements.householdId, hh),
                or(eq(settlements.fromUserId, userId), eq(settlements.toUserId, userId)),
              ),
            )
            .orderBy(asc(settlements.id)),
        ),
      ),
    ];
    yield [
      `${dir}/audit.json`,
      exportJson(
        await inHh(db, userId, hh, (tx) =>
          tx
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.householdId, hh), eq(auditEvents.actorUserId, userId)))
            .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id)),
        ),
      ),
    ];
    for (const d of docs) {
      const key = d.storageKey;
      if (!key || d.fileDeletedAt !== null || !isKeyOfHousehold(key, hh)) continue;
      let source: AsyncIterable<Uint8Array>;
      try {
        source = await deps.storage.openRead(key);
      } catch {
        // Fișier lipsă (de exemplu șters la retenție între timp): sărit, fără detalii.
        continue;
      }
      yield [`${dir}/fisiere/${d.id}.${EXT[d.detectedMime] ?? "bin"}`, source, { method: "store" }];
    }
  }
}
