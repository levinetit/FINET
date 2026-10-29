import { randomUUID } from "node:crypto";

import { type Storage, StorageNotFoundError, type StorageKey } from "@/lib/storage";

/**
 * Doar pentru testele GDPR: un storage în memorie care implementează TOATĂ interfața `Storage`
 * (lecția F6: mock-urile parțiale ascund erori). Nu se importă din aplicație.
 */
export class MemoryStorage implements Storage {
  readonly files = new Map<string, Uint8Array>();
  /** Cheile pentru care `delete` aruncă (simularea unei erori de disc). */
  readonly failDelete = new Set<string>();

  async put(data: Uint8Array): Promise<StorageKey> {
    const key = `files/${randomUUID()}` as StorageKey;
    this.files.set(key, data);
    return key;
  }
  async get(key: StorageKey): Promise<Uint8Array> {
    const v = this.files.get(key);
    if (!v) throw new StorageNotFoundError();
    return v;
  }
  async delete(key: StorageKey): Promise<void> {
    if (this.failDelete.has(key)) throw new Error("eroare simulată");
    this.files.delete(key);
  }
  async exists(key: StorageKey): Promise<boolean> {
    return this.files.has(key);
  }
  async putStream(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<StorageKey> {
    const parts: Uint8Array[] = [];
    for await (const p of source) parts.push(p);
    return this.put(Buffer.concat(parts));
  }
  async openRead(key: StorageKey): Promise<AsyncIterable<Uint8Array>> {
    const v = await this.get(key);
    return (async function* () {
      // Pe bucăți mici, ca fluxul să fie exersat.
      for (let i = 0; i < v.byteLength; i += 1024) yield v.subarray(i, i + 1024);
    })();
  }
  /** Pune direct un fișier la o cheie dată (documentele din teste). */
  seed(key: string, data: Uint8Array): void {
    this.files.set(key, data);
  }
}
