import "server-only";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";

import { type AuthRuntime, getAuthRuntime } from "@/modules/auth/auth";
import { type SessionInfo, UnauthenticatedError, requireSession } from "@/modules/auth/session";

import { loginUrlFor } from "./next-path";

/**
 * Sesiunea pentru paginile server (App Router): aceeași verificare ca `/api/v1/*`
 * (`requireSession`: Better Auth în bază, fără cookie cache, utilizator activ), pe antetele
 * cererii curente. FAIL CLOSED: orice eroare (bază indisponibilă, configurație incompletă)
 * înseamnă „fără sesiune”, deci pagina de login, niciodată acces.
 */

export type PageSession = SessionInfo & Readonly<{ runtime: AuthRuntime }>;

export async function getPageSession(): Promise<PageSession | null> {
  // În afara `try`: `headers()` semnalează randarea dinamică printr-o excepție proprie Next.
  const incoming = await headers();
  try {
    const runtime = getAuthRuntime();
    const request = new Request(new URL("/", runtime.config.appUrl ?? "http://localhost:3000"), {
      headers: new Headers(incoming),
    });
    const session = await requireSession(request, runtime);
    return { ...session, runtime };
  } catch (error) {
    unstable_rethrow(error);
    if (!(error instanceof UnauthenticatedError)) {
      // Fără detalii: mesajul erorii poate cita configurația sau baza.
      console.error("[ui] sesiunea nu a putut fi verificată");
    }
    return null;
  }
}

/** Sesiunea obligatorie: fără ea, redirecționare la `/login?next=<path>` (validat). */
export async function requirePageSession(path: string): Promise<PageSession> {
  const session = await getPageSession();
  if (!session) redirect(loginUrlFor(path));
  return session;
}
