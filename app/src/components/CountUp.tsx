import { useEffect, useRef, useState } from "react";

// Eased count-up for stat values. `to` is the numeric target; `render` formats
// each intermediate frame (so it composes with bigint/amount formatters). Falls
// back to the final value immediately under reduced-motion.
export default function CountUp({
  to,
  render,
  duration = 900,
}: {
  to: number;
  render: (n: number) => string;
  duration?: number;
}) {
  const [n, setN] = useState(to);
  const raf = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !isFinite(to)) {
      setN(to);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo
      const e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setN(from + (to - from) * e);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      fromRef.current = to;
    };
  }, [to, duration]);

  return <>{render(n)}</>;
}
