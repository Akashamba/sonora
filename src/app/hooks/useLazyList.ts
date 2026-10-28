import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/api";

// Fetches a list the first time `active` turns true, then keeps it. Mirrors the vanilla tabs,
// which loaded each tab on first visit and kept the result.
export function useLazyList<T>(
  active: boolean,
  fetchItems: () => Promise<T[]>,
) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (!active || requested.current) return;
    requested.current = true;
    fetchItems()
      .then(setItems)
      .catch((e: unknown) => setError(errorMessage(e)));
    // fetchItems is a module-level function, so this runs once per mount in practice.
  }, [active, fetchItems]);

  return { items, error };
}
