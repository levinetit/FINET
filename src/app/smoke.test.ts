import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

// Test banal care confirmă că Vitest și aliasul `@/` funcționează.
describe("cn", () => {
  it("unește clasele și rezolvă conflictele Tailwind", () => {
    expect(cn("p-2 text-fg", false, "p-4")).toBe("text-fg p-4");
  });
});
