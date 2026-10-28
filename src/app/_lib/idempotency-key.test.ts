import { describe, expect, it } from "vitest";

import { afterResponse, keyFor, newIdempotencyKey } from "./idempotency-key";

// Aceeași regulă ca serverul (`isValidIdempotencyKey`): 16–128 caractere `[A-Za-z0-9_-]`.
const SERVER_KEY = /^[A-Za-z0-9_-]{16,128}$/;

describe("cheia Idempotency-Key a formularelor", () => {
  it("cheia generată respectă formatul cerut de server", () => {
    for (let i = 0; i < 20; i++) expect(newIdempotencyKey()).toMatch(SERVER_KEY);
  });

  it("aceeași trimitere (același corp) păstrează cheia; un corp nou primește alta", () => {
    let n = 0;
    const gen = () => `cheie-de-test-${String(++n).padStart(4, "0")}`;
    const a = keyFor(null, '{"x":1}', gen);
    const again = keyFor(a.state, '{"x":1}', gen);
    expect(again.key).toBe(a.key);
    const other = keyFor(a.state, '{"x":2}', gen);
    expect(other.key).not.toBe(a.key);
  });

  it.each([
    [0, null, true],
    [500, "internal_error", true],
    [503, null, true],
    [409, "request_in_progress", true],
    [201, null, false],
    [200, null, false],
    [400, "invalid_request", false],
    [404, "not_found", false],
    [409, "conflict", false],
    [422, "idempotency_key_reused", false],
    [429, "rate_limited", false],
  ])("după status %i (%s) cheia se păstrează: %s", (status, code, kept) => {
    const state = { key: "k".repeat(20), body: "{}" };
    expect(afterResponse(state, status, code) === state).toBe(kept);
  });

  it("după un succes, o nouă trimitere a aceluiași corp e o cerere nouă (cheie nouă)", () => {
    const first = keyFor(null, "{}", () => "a".repeat(20));
    const cleared = afterResponse(first.state, 201, null);
    expect(keyFor(cleared, "{}", () => "b".repeat(20)).key).toBe("b".repeat(20));
  });
});
