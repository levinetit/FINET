import { describe, expect, it } from "vitest";

import { activeUploads, tryAcquireUploadSlot } from "./upload-slots";

describe("plafonul încărcărilor simultane (M1)", () => {
  it("cel mult 2 locuri; eliberarea e idempotentă și redeschide un loc", () => {
    const a = tryAcquireUploadSlot();
    const b = tryAcquireUploadSlot();
    expect(a && b).toBeTruthy();
    expect(tryAcquireUploadSlot()).toBeNull();
    a!();
    a!();
    expect(activeUploads()).toBe(1);
    const c = tryAcquireUploadSlot();
    expect(c).toBeTruthy();
    b!();
    c!();
    expect(activeUploads()).toBe(0);
  });
});
