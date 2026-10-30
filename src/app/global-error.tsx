"use client";

import { useEffect } from "react";

import { isChunkLoadError } from "@/app/_lib/chunk-recovery";
import { reportClientError } from "@/lib/error-report";
import { recoverFromChunkError } from "@/components/app/chunk-recovery";
import { ro } from "@/messages/ro";

import "./globals.css";

/**
 * Pagina `global-error` proprie (Faza 4): înlocuiește layout-ul rădăcină când acesta aruncă.
 * Cea implicită din Next are atribute `style`, blocate de CSP. În română, fără detalii tehnice,
 * cu buton de reîncărcare; un fișier JavaScript lipsă (deploy) declanșează aceeași recuperare.
 */
export default function GlobalError({ error }: Readonly<{ error: Error & { digest?: string } }>) {
  useEffect(() => {
    if (isChunkLoadError(error)) recoverFromChunkError();
    else reportClientError(error, window.location.pathname);
  }, [error]);

  return (
    <html lang="ro">
      <body>
        <title>{`${ro.common.globalErrorTitle} · ${ro.app.name}`}</title>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-2xl font-bold">{ro.common.errorTitle}</h1>
          <p role="alert" className="text-muted-foreground">
            {ro.common.unexpected}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-border bg-surface px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ro.common.reload}
          </button>
        </main>
      </body>
    </html>
  );
}
