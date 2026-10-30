import { describe, expect, it, vi } from "vitest";

import { TURNSTILE_VERIFY_URL, type TurnstileFetcher, createTurnstileVerifier } from "./turnstile";

const ok = (body: unknown): ReturnType<TurnstileFetcher> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function verifier(fetcher: TurnstileFetcher, timeoutMs?: number) {
  return createTurnstileVerifier({
    secretKey: "secret-fals-0123456789",
    hostname: "finet.exemplu.ro",
    fetcher,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

describe("verificatorul Turnstile (fail-closed)", () => {
  it("acceptă doar success:true cu gazda aplicației; trimite secretul, tokenul și IP-ul de încredere", async () => {
    const fetcher = vi.fn<TurnstileFetcher>(() =>
      ok({ success: true, hostname: "finet.exemplu.ro" }),
    );
    await expect(verifier(fetcher)("tok-123", "203.0.113.7")).resolves.toBe(true);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init.method).toBe("POST");
    expect(init.body.get("secret")).toBe("secret-fals-0123456789");
    expect(init.body.get("response")).toBe("tok-123");
    expect(init.body.get("remoteip")).toBe("203.0.113.7");
  });

  it("nu trimite remoteip fără IP de încredere", async () => {
    const fetcher = vi.fn<TurnstileFetcher>(() =>
      ok({ success: true, hostname: "finet.exemplu.ro" }),
    );
    await verifier(fetcher)("tok", null);
    expect(fetcher.mock.calls[0]![1].body.has("remoteip")).toBe(false);
  });

  it("respinge: success:false, gazdă diferită, câmpuri lipsă, JSON nepotrivit", async () => {
    for (const body of [
      { success: false, "error-codes": ["timeout-or-duplicate"] },
      { success: true, hostname: "alt-site.ro" },
      { success: true },
      { success: "true", hostname: "finet.exemplu.ro" },
      null,
      [],
      "ok",
    ]) {
      await expect(verifier(() => ok(body))("tok", null), JSON.stringify(body)).resolves.toBe(
        false,
      );
    }
  });

  it("respinge: status non-200, JSON invalid, eroare de rețea, timeout", async () => {
    await expect(
      verifier(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({ success: true }) }),
      )("t", null),
    ).resolves.toBe(false);
    await expect(
      verifier(() =>
        Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("json")) }),
      )("t", null),
    ).resolves.toBe(false);
    await expect(
      verifier(() => Promise.reject(new Error("ECONNREFUSED")))("t", null),
    ).resolves.toBe(false);
    const hang: TurnstileFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("abort")));
      });
    await expect(verifier(hang, 20)("t", null)).resolves.toBe(false);
  });

  it("respinge fără apel de rețea un token gol sau mai lung de 2048 de caractere", async () => {
    const fetcher = vi.fn<TurnstileFetcher>(() =>
      ok({ success: true, hostname: "finet.exemplu.ro" }),
    );
    const verify = verifier(fetcher);
    await expect(verify("", null)).resolves.toBe(false);
    await expect(verify("x".repeat(2049), null)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
