"use client";

import { useCallback, useRef, useState } from "react";

import { type ApiResult, apiFetch } from "./api-client";
import { type KeyState, afterResponse, keyFor } from "./idempotency-key";

type Method = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * O mutație din formular: cel mult o cerere în zbor (blocare SINCRONĂ în `useRef`, nu doar
 * butonul dezactivat: un dublu-clic declanșează două evenimente înainte ca React să redeseneze),
 * cu `Idempotency-Key` opțional legat de corpul trimis (`idempotency-key.ts`).
 */
export function useSubmit() {
  const lock = useRef(false);
  const keyState = useRef<KeyState>(null);
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async <T>(
      path: string,
      method: Method,
      body?: unknown,
      options: Readonly<{
        idempotent?: boolean;
        /** După un 2xx blocarea rămâne (formularul pleacă din pagină): fără a doua trimitere. */
        lockOnSuccess?: boolean;
      }> = {},
    ): Promise<ApiResult<T> | null> => {
      if (lock.current) return null;
      lock.current = true;
      setPending(true);
      let keepLocked = false;
      try {
        const raw = body === undefined ? undefined : JSON.stringify(body);
        let idempotencyKey: string | undefined;
        if (options.idempotent && raw !== undefined) {
          const next = keyFor(keyState.current, `${method} ${path} ${raw}`);
          keyState.current = next.state;
          idempotencyKey = next.key;
        }
        const result = await apiFetch<T>(path, { method, rawBody: raw, idempotencyKey });
        if (options.idempotent) {
          keyState.current = afterResponse(keyState.current, result.status, result.error?.code);
        }
        keepLocked = Boolean(options.lockOnSuccess && result.ok);
        return result;
      } finally {
        lock.current = keepLocked;
        setPending(keepLocked);
      }
    },
    [],
  );

  return { submit, pending };
}
