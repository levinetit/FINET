"use client";

import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

// Eroare neprevăzută la randare: mesaj generic, fără detalii (6.3, erori uniforme).
export default function ErrorPage({ reset }: Readonly<{ error: Error; reset: () => void }>) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">{ro.common.errorTitle}</h1>
      <p role="alert" className="text-muted-foreground">
        {ro.common.unexpected}
      </p>
      <Button variant="outline" onClick={reset}>
        {ro.common.retry}
      </Button>
    </main>
  );
}
