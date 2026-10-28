"use client";

import { useRef, useState } from "react";

import { goToLogin } from "@/app/_lib/api-client";
import { downloadCsv } from "@/app/_lib/download";
import { useHydrated } from "@/app/_lib/use-hydrated";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

/**
 * Butonul „Export CSV”: o descărcare în zbor (blocare sincronă, ca `useSubmit`), mesaj clar la
 * 409 `export_too_large` și la 429. `path` include deja `dialect=ro` (`exportPath`).
 */
export function ExportButton({
  path,
  label,
  filename,
  testId,
}: Readonly<{ path: string; label: string; filename: string; testId?: string }>) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const hydrated = useHydrated();

  async function run() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    setDone(false);
    try {
      const outcome = await downloadCsv(path, filename);
      if (outcome.ok) {
        setDone(true);
        return;
      }
      if (outcome.status === 401) {
        goToLogin();
        return;
      }
      setError(outcome.message);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          onClick={() => void run()}
          disabled={pending || !hydrated}
          data-testid={testId}
        >
          {pending ? ro.exports.downloading : label}
        </Button>
      </div>
      <Alert>{error}</Alert>
      <Alert tone="ok" className={done ? "sr-only" : undefined}>
        {done ? ro.exports.done : null}
      </Alert>
    </div>
  );
}
