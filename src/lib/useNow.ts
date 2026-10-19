import { useEffect, useState } from "react";

/** Hora actual que se re-renderiza cada `intervalMs`: "hace 3 min" no se congela. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
