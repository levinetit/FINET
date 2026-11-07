import { describe, expect, it } from "vitest";

import { fetchEcb, parseEcbXml, rateToMicro } from "./ecb";

/** Parserul BCE (ADR 0049): format fix, doar monedele aplicației, fără float. */

const DAILY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-10-28'>
      <Cube currency='USD' rate='1.0856'/>
      <Cube currency='JPY' rate='162.31'/>
      <Cube currency='RON' rate='4.9700'/>
      <Cube currency='HUF' rate='410.25'/>
      <Cube currency='GBP' rate='0.8573'/>
      <Cube currency='XXX' rate='abc'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("rateToMicro", () => {
  it("convertește șirul zecimal exact, cel mult 6 zecimale", () => {
    expect(rateToMicro("1.0856")).toBe(1_085_600n);
    expect(rateToMicro("410.25")).toBe(410_250_000n);
    expect(rateToMicro("4")).toBe(4_000_000n);
    expect(rateToMicro("0.8573")).toBe(857_300n);
    expect(rateToMicro("1.1234567")).toBeNull();
    expect(rateToMicro("abc")).toBeNull();
    expect(rateToMicro("0")).toBeNull();
    expect(rateToMicro("-1")).toBeNull();
  });
});

describe("parseEcbXml", () => {
  it("citește ziua și doar monedele aplicației (fără EUR, JPY, invalide)", () => {
    expect(parseEcbXml(DAILY)).toEqual([
      { date: "2026-10-28", currency: "USD", rateMicro: 1_085_600n },
      { date: "2026-10-28", currency: "RON", rateMicro: 4_970_000n },
      { date: "2026-10-28", currency: "HUF", rateMicro: 410_250_000n },
      { date: "2026-10-28", currency: "GBP", rateMicro: 857_300n },
    ]);
  });
  it("istoricul: mai multe zile; gol pentru XML străin sau prea mare", () => {
    const hist = `<Cube><Cube time="2026-10-27"><Cube currency="RON" rate="4.96"/></Cube><Cube time="2026-10-28"><Cube currency="RON" rate="4.97"/></Cube></Cube>`;
    expect(parseEcbXml(hist).map((r) => [r.date, r.rateMicro])).toEqual([
      ["2026-10-27", 4_960_000n],
      ["2026-10-28", 4_970_000n],
    ]);
    expect(parseEcbXml("<html>nope</html>")).toEqual([]);
    expect(parseEcbXml("x".repeat(3 * 1024 * 1024))).toEqual([]);
  });
});

describe("fetchEcb", () => {
  it("refuză altă gazdă sau http; acceptă doar www.ecb.europa.eu pe https", async () => {
    await expect(fetchEcb("https://example.com/x.xml")).rejects.toThrow("fx_url_not_allowed");
    await expect(fetchEcb("http://www.ecb.europa.eu/x.xml")).rejects.toThrow("fx_url_not_allowed");
    const fake = (async () => new Response(DAILY, { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchEcb("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", fake),
    ).resolves.toContain("Cube");
    const bad = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchEcb("https://www.ecb.europa.eu/x.xml", bad)).rejects.toThrow("fx_http_503");
    const big = (async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024) },
      })) as unknown as typeof fetch;
    await expect(fetchEcb("https://www.ecb.europa.eu/x.xml", big)).rejects.toThrow("fx_too_large");
  });
});
