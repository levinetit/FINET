"use client";

import { useEffect } from "react";

import { isChunkLoadError } from "@/app/_lib/chunk-recovery";
import { reportClientError } from "@/lib/error-report";
import { recoverFromChunkError } from "@/components/app/chunk-recovery";
import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

// Eroare neprevăzută la randare: mesaj generic, fără detalii (6.3, erori uniforme). Un fișier
// JavaScript lipsă după un deploy (navigare în aplicație) ajunge AICI, nu la ascultătorii din
// `window`: aceeași decizie ca în `ChunkRecovery` (reîncărcare cel mult o dată la 8 secunde).
export default function ErrorPage({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  // Chunk lipsă: mesajul „versiune nouă” (dacă pagina se reîncarcă, oricum dispare).
  const stale = isChunkLoadError(error);
  useEffect(() => {
    if (isChunkLoadError(error)) recoverFromChunkError();
    else reportClientError(error, window.location.pathname);
  }, [error]);

  return (
    <main
      id="continut"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-bold">{ro.common.errorTitle}</h1>
      <p role="alert" className="text-muted-foreground">
        {stale ? ro.common.newVersion : ro.common.unexpected}
      </p>
      {stale ? (
        <Button variant="outline" onClick={() => window.location.reload()}>
          {ro.common.reload}
        </Button>
      ) : (
        <Button variant="outline" onClick={reset}>
          {ro.common.retry}
        </Button>
      )}
    </main>
  );
}
