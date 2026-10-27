import "server-only";

import { ConfigError, getConfig } from "@/lib/config";

/**
 * Validarea configurației la pornire (apelată din `src/instrumentation.ts`, doar în runtime-ul
 * Node). Dacă e invalidă: scrie problemele (fără valori) și oprește procesul, ca aplicația să nu
 * ruleze pe jumătate configurată.
 */
export function validateConfigOrExit(): void {
  try {
    getConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Configurație invalidă.");
    process.exit(1);
  }
}
