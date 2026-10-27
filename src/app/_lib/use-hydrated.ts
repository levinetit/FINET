"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * `false` la randarea pe server și în timpul hidratării, `true` după. Butoanele formularelor
 * rămân dezactivate până atunci: un clic înainte de hidratare ar trimite formularul nativ (fără
 * JavaScript), iar parola nu trebuie să ajungă niciodată într-un URL sau într-o cerere ne-JSON.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
