// Bounded polling: while ``active``, call ``tick`` every ``ms`` up to ``maxTicks`` times; a new ``resetKey``
// (e.g. a run just started) restarts the budget. Used while a branch regression or an apply job is running.
import { useEffect, useRef, useState } from "react";

export function usePoll(active: boolean, tick: () => void, ms: number, maxTicks: number, resetKey?: unknown): void {
  const [count, setCount] = useState(0);
  const tickRef = useRef(tick);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    setCount(0);
  }, [resetKey]);

  useEffect(() => {
    if (!active || count >= maxTicks) return;
    const timer = setTimeout(() => {
      setCount((n) => n + 1);
      tickRef.current();
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [active, count, ms, maxTicks]);
}
