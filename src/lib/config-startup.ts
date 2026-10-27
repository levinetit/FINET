import "server-only";

import { ConfigError, getConfig } from "@/lib/config";

/**
 * Validarea configurației la pornire (apelată din `src/instrumentation.ts`, doar în runtime-ul
 * Node). Dacă e invalidă: scrie problemele (fără valori) și oprește procesul, ca aplicația să nu
 * ruleze pe jumătate configurată. Serverul Next.js e mereu rolul `web`: cu alt `FINET_ROLE`
 * (care i-ar permite URL-ul altui rol) nu pornește.
 */
export function validateConfigOrExit(): void {
  try {
    const config = getConfig();
    if (config.role !== "web") {
      throw new ConfigError([
        { variable: "FINET_ROLE", problem: "serverul web pornește doar cu FINET_ROLE=web" },
      ]);
    }
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Configurație invalidă.");
    process.exit(1);
  }
}
