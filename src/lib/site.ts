import "server-only";

import { notFound } from "next/navigation";

import { type Config, getConfig } from "@/lib/config";

/**
 * Site-ul public (Faza 11, ADR 0027): paginile există DOAR în modul `saas`. În `personal` (și la
 * orice configurație care nu se poate citi) ruta răspunde 404, ca și cum n-ar exista.
 */
export function siteConfigOrNotFound(): Config["site"] {
  let config: Config;
  try {
    config = getConfig();
  } catch {
    notFound();
  }
  if (config.appMode !== "saas") notFound();
  return config.site;
}

/** Fără aceeași excepție (pentru pagina `/`, care în `personal` redirecționează ca până acum). */
export function isSaasMode(): boolean {
  try {
    return getConfig().appMode === "saas";
  } catch {
    return false;
  }
}
