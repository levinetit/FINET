import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";

import { sql } from "drizzle-orm";

import { type Db, withRlsOn } from "@/db";

/**
 * Fișierele orfane din storage (revizuirea F9, ADR 0021 §1): directoarele `households/<id>/` ale
 * căror gospodărie NU mai există în bază (ștergerea contului șterge rândurile într-o tranzacție,
 * apoi fișierele; dacă pasul al doilea eșuează, rămân fișiere neservite de nicio rută). Comanda
 * `finet-admin cleanup-orphan-storage`.
 *
 * Siguranța (aceeași regulă ca `cleanup-documents`: fără `households/` montat nu se atinge nimic):
 * - doar storage-ul local (`STORAGE_DIR`), doar intrările-director cu nume uuid (nu legături, nu
 *   fișiere), doar sub `<STORAGE_DIR>/households` după `realpath`;
 * - existența gospodăriilor o spune baza (`finet.existing_households`, doar id-uri);
 * - implicit DOAR raport (dry-run); ștergerea cere `--yes` și e plafonată (`limit`);
 * - dacă NICIUN director nu are gospodărie în bază (și sunt cel puțin 2), refuză: probabil baza
 *   greșită sau goală, nu orfane.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ORPHAN_LIMIT_MAX = 1000;
const LOOKUP_BATCH = 1000;

export type OrphanResult = Readonly<{
  /** Directoarele de gospodărie găsite în storage. */
  scanned: number;
  /** Cele fără gospodărie în bază. */
  orphans: number;
  /** Șterse (0 în dry-run). */
  deleted: number;
  /** Ignorate (nume ne-uuid, legături, fișiere). */
  skipped: number;
}>;

export class OrphanSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrphanSafetyError";
  }
}

async function existing(db: Db, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const batch = ids.slice(i, i + LOOKUP_BATCH);
    const rows = await withRlsOn(db, { userId: null }, (tx) =>
      tx.execute<{ id: string }>(
        sql`select finet.existing_households(${`{${batch.join(",")}}`}::uuid[]) as id`,
      ),
    );
    for (const r of rows) found.add(String(r.id).toLowerCase());
  }
  return found;
}

export async function cleanupOrphanStorage(
  options: Readonly<{ db: Db; storageDir: string; apply: boolean; limit?: number }>,
): Promise<OrphanResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), ORPHAN_LIMIT_MAX);
  const base = await realpath(options.storageDir);
  const root = join(base, "households");
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    // `households/` lipsește: storage nemontat sau încă niciun document. Nimic de făcut.
    return { scanned: 0, orphans: 0, deleted: 0, skipped: 0 };
  }
  if (rootReal !== root) throw new OrphanSafetyError("households/ nu e un director obișnuit");

  const dirs: string[] = [];
  let skipped = 0;
  for (const name of await readdir(root)) {
    const st = await lstat(join(root, name));
    if (!UUID.test(name) || !st.isDirectory() || st.isSymbolicLink()) {
      skipped += 1;
      continue;
    }
    dirs.push(name);
  }
  const present = await existing(options.db, dirs);
  const orphans = dirs.filter((d) => !present.has(d));
  if (dirs.length >= 2 && orphans.length === dirs.length) {
    throw new OrphanSafetyError(
      "niciun director din storage nu are gospodărie în bază: verifică DATABASE_URL și STORAGE_DIR",
    );
  }
  let deleted = 0;
  if (options.apply) {
    for (const id of orphans.slice(0, limit)) {
      const target = join(root, id);
      const real = await realpath(target);
      // Apărare în adâncime: exact un nivel sub `households/`, fără legături.
      if (real !== target || !real.startsWith(root + sep)) continue;
      await rm(target, { recursive: true, force: true });
      deleted += 1;
    }
  }
  return { scanned: dirs.length, orphans: orphans.length, deleted, skipped };
}
