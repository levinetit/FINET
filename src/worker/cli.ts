import "server-only";

import { ConfigError, parseConfig } from "@/lib/config";

import { LocalStorage } from "@/lib/storage";

import { PgTlsConfigError } from "./boss";
import { DEFAULT_PREPROCESS_TIMEOUT_MS } from "./receipts/preprocess";
import { aiRuntimeFromConfig } from "./receipts/receipt-jobs";
import { type RunningWorker, errorCode, startWorker } from "./main";

/**
 * Punctul de intrare al containerului `finet-worker` (imaginea de unelte, `dist/tools/worker.mjs`):
 *   FINET_ROLE=worker WORKER_DATABASE_URL_FILE=/run/secrets/... node dist/tools/worker.mjs
 *
 * Configurația trece prin `parseConfig` (doar URL-ul rolului `worker`; CA din DATABASE_CA_FILE cu
 * `sslmode=verify-full`). Logurile sunt linii JSON pe stdout, fără URL-uri, parole, sume sau
 * descrieri. Cod de ieșire: 0 după o oprire grațioasă, 1 la eroare de pornire.
 */

export type WorkerIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** Înregistrează funcția de oprire pentru SIGTERM/SIGINT (în teste: apelată direct). */
  onSignal: (stop: () => Promise<void>) => void;
}>;

export async function main(io: WorkerIo): Promise<{ code: number; worker: RunningWorker | null }> {
  const log = (event: Readonly<Record<string, string | number | boolean>>) =>
    io.out(JSON.stringify({ service: "finet-worker", time: new Date().toISOString(), ...event }));
  try {
    const config = parseConfig(io.env);
    if (config.role !== "worker") {
      log({ event: "start_failed", reason: "role_not_worker" });
      return { code: 1, worker: null };
    }
    if (!config.database.url) {
      log({ event: "start_failed", reason: "missing_database_url" });
      return { code: 1, worker: null };
    }
    const worker = await startWorker({
      databaseUrl: config.database.url,
      databaseCa: config.database.ca,
      allowInsecure: config.database.allowInsecure,
      log,
      // Bonurile (Faza 6): storage-ul DOAR citire (montaj read-only în compose; ADR 0013) și
      // furnizorul AI (`null` dacă AI_BASE_URL/AI_API_KEY_FILE lipsesc: introducere manuală).
      receipts:
        config.storage.driver === "local"
          ? {
              storage: new LocalStorage(config.storage.dir, { readOnly: true }),
              limits: {
                maxImagePixels: config.documents.maxImagePixels,
                maxPdfPages: config.documents.maxPdfPages,
                timeoutMs: DEFAULT_PREPROCESS_TIMEOUT_MS,
                duplicateMaxDistance: config.documents.duplicateMaxDistance,
              },
              ai: aiRuntimeFromConfig(config),
            }
          : undefined,
    });
    log({
      event: "receipts",
      enabled: config.storage.driver === "local",
      ai: config.ai.baseUrl !== null && config.ai.apiKey !== null,
    });
    io.onSignal(worker.stop);
    return { code: 0, worker };
  } catch (error) {
    if (error instanceof PgTlsConfigError) {
      log({ event: "start_failed", reason: "tls_config", detail: error.problem });
    } else if (error instanceof ConfigError) {
      // Mesajul ConfigError numește doar variabilele și problemele, niciodată valorile.
      log({ event: "start_failed", reason: "config", detail: error.message });
    } else {
      log({ event: "start_failed", reason: "error", code: errorCode(error) });
    }
    return { code: 1, worker: null };
  }
}
