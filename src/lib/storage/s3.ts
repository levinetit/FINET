import "server-only";

import type { S3Config } from "@/lib/config";
import { NotImplementedError } from "@/lib/errors";
import type { Storage, StorageKey } from "@/lib/storage/types";

const MESSAGE = "S3 vine în Faza 6";

/**
 * Schelet tipizat pentru Supabase Storage prin protocolul S3. Fără SDK S3 nici în Faza 6 (decizia mea, ADR 0013: producția folosește driverul `local`):
 * fiecare operație aruncă `NotImplementedError`, ca nimic să nu pară că funcționează.
 * Metodele nu-și declară parametrii (nefolosiți încă); semnătura completă vine din `Storage`.
 */
export class S3Storage implements Storage {
  constructor(private readonly config: S3Config) {}

  async put(): Promise<StorageKey> {
    throw new NotImplementedError(MESSAGE);
  }

  async get(): Promise<Uint8Array> {
    throw new NotImplementedError(MESSAGE);
  }

  async delete(): Promise<void> {
    throw new NotImplementedError(MESSAGE);
  }

  async exists(): Promise<boolean> {
    throw new NotImplementedError(MESSAGE);
  }

  async putStream(): Promise<StorageKey> {
    throw new NotImplementedError(MESSAGE);
  }

  async openRead(): Promise<AsyncIterable<Uint8Array>> {
    throw new NotImplementedError(MESSAGE);
  }
}
