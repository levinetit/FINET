import { afterEach, describe, expect, it } from "vitest";

import { parseClientInfo } from "@/modules/auth/request";

import {
  INSTALLATION_STORAGE_KEY,
  clientHeaderFor,
  clientHeaderValue,
  installationId,
  setUsageStatsEnabled,
} from "./usage-client";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

const UUID = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";

describe("antetul X-FINET-Client al clientului web", () => {
  afterEach(() => setUsageStatsEnabled(false));

  it("forma trimisă e validă pentru parserul serverului (platform=web)", () => {
    const info = parseClientInfo(clientHeaderValue(UUID));
    expect(info).not.toBeNull();
    expect(info?.platform).toBe("web");
    expect(info?.installationId).toBe(UUID);
    expect(info?.locale).toBe("ro-RO");
    expect(info?.appVersion).toBeNull();
  });

  it("fără consimțământ nu se trimite nimic; cu consimțământ doar pe /api/v1/*", () => {
    expect(clientHeaderFor("/api/v1/accounts")).toBeNull();
    setUsageStatsEnabled(true);
    expect(parseClientInfo(clientHeaderFor("/api/v1/accounts"))?.platform).toBe("web");
    expect(clientHeaderFor("/api/auth/sign-in/email")).toBeNull();
    expect(clientHeaderFor("/dashboard")).toBeNull();
    setUsageStatsEnabled(false);
    expect(clientHeaderFor("/api/v1/accounts")).toBeNull();
  });

  it("instalarea se păstrează în stocare și se refolosește", () => {
    // (Pe pagina curentă poate exista deja o instalare din memorie; contează stabilitatea.)
    const storage = memoryStorage();
    const id = installationId(storage, () => UUID);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.data.get(INSTALLATION_STORAGE_KEY)).toBe(id);
    expect(installationId(storage, () => "altceva")).toBe(id);
    const existing = memoryStorage({ [INSTALLATION_STORAGE_KEY]: UUID });
    expect(installationId(existing, () => "altceva")).toBe(UUID);
  });

  it("o valoare stocată invalidă e înlocuită; stocarea blocată nu aruncă", () => {
    const storage = memoryStorage({ [INSTALLATION_STORAGE_KEY]: "nu-e-uuid" });
    const id = installationId(storage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const blocked = {
      getItem: () => {
        throw new Error("blocat");
      },
      setItem: () => {
        throw new Error("blocat");
      },
    };
    expect(() => installationId(blocked)).not.toThrow();
  });
});
