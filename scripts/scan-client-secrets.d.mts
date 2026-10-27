// Tipuri pentru scripts/scan-client-secrets.mjs (folosite de teste).
export declare const SECRET_PATTERNS: { name: string; regex: RegExp }[];
export declare function parseSecretNames(text: string): string[];
export declare function scanDirectory(
  dir: string,
  options?: { secretNames?: string[] },
): { file: string; kind: string }[];
