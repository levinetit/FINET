// Tipuri pentru scripts/check-bundle-size.mjs (folosite de teste).
export type BundleRow = { route: string; key: string; files: string[]; gzipBytes: number };
export type Budget = { defaultKiB: number; routes: Record<string, number> };
export declare function routeOf(key: string): string;
export declare function parseClientReferenceManifest(text: string): {
  key: string;
  manifest: { entryJSFiles?: Record<string, string[]> };
};
export declare function measureRoutes(nextDir: string): BundleRow[];
export declare function parseBudget(markdown: string): Budget;
export declare function limitFor(budget: Budget, route: string): number;
export declare function evaluate(
  rows: BundleRow[],
  budget: Budget,
): (BundleRow & { kib: number; limitKiB: number; ok: boolean })[];
