import { useId } from "react";
import type { MarginPoint } from "../lib/stellar.ts";
import { fmtAmount } from "../lib/format.ts";

// Dependency-free premium SVG of solvency margin (reserves − net_custodied)
// per epoch: gradient area fill, smooth curve, animated draw, danger line at 0.
export default function MarginChart({ points }: { points: MarginPoint[] }) {
  const gid = useId().replace(/:/g, "");
  if (points.length === 0) {
    return (
      <div className="chart-empty">
        <div className="chart-empty-line" />
        <p className="muted small">
          No attestations yet — the margin feed draws itself as proofs are posted.
        </p>
      </div>
    );
  }
  const W = 680;
  const H = 190;
  const padX = 30;
  const padY = 26;
  const margins = points.map((p) => Number(p.reserves - p.net_custodied));
  const max = Math.max(...margins, 1);
  const min = Math.min(...margins, 0);
  const span = max - min || 1;
  const x = (i: number) =>
    padX + (points.length === 1 ? (W - 2 * padX) / 2 : (i * (W - 2 * padX)) / (points.length - 1));
  const y = (v: number) => H - padY - ((v - min) / span) * (H - 2 * padY);
  const zeroY = y(0);

  // smooth-ish path via simple Catmull-Rom → bezier
  const pts = margins.map((m, i) => [x(i), y(m)] as const);
  let d = pts.length ? `M ${pts[0][0]},${pts[0][1]}` : "";
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[Math.max(0, i - 1)];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const [x3, y3] = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
  }
  const area = pts.length ? `${d} L ${pts[pts.length - 1][0]},${H - padY} L ${pts[0][0]},${H - padY} Z` : "";
  const lastNeg = margins[margins.length - 1] < 0;
  const stroke = lastNeg ? "var(--red)" : "var(--green)";

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="solvency margin trend">
        <defs>
          <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lastNeg ? "var(--red)" : "var(--green)"} stopOpacity="0.28" />
            <stop offset="100%" stopColor={lastNeg ? "var(--red)" : "var(--green)"} stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${gid}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={padX} y1={padY + g * (H - 2 * padY)} x2={W - padX} y2={padY + g * (H - 2 * padY)}
            stroke="var(--border)" strokeWidth="1" opacity="0.5" />
        ))}

        {/* danger line at margin = 0 */}
        <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke="var(--red)" strokeDasharray="5 5" strokeWidth="1" opacity="0.7" />
        <text x={W - padX} y={zeroY - 5} fill="var(--red)" fontSize="10" textAnchor="end" opacity="0.85">danger · margin = 0</text>

        {/* area + line */}
        {area && <path d={area} fill={`url(#fill-${gid})`} className="chart-area" />}
        <path d={d} fill="none" stroke={stroke} strokeWidth="2.5" filter={`url(#glow-${gid})`}
          className="chart-line" strokeLinecap="round" strokeLinejoin="round" />

        {/* points */}
        {pts.map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r={i === pts.length - 1 ? 4.5 : 3}
            fill={margins[i] < 0 ? "var(--red)" : "var(--green)"} stroke="var(--bg)" strokeWidth="1.5"
            className={i === pts.length - 1 ? "chart-last" : ""} />
        ))}
      </svg>
      <div className="kv">
        <span className="k">latest margin (reserves − floor)</span>
        <span className="v" style={{ color: lastNeg ? "var(--red)" : "var(--green)" }}>
          {fmtAmount(points[points.length - 1].reserves - points[points.length - 1].net_custodied)}
        </span>
      </div>
      <div className="kv">
        <span className="k">epochs shown</span>
        <span className="v">{points[0].epoch}–{points[points.length - 1].epoch}</span>
      </div>
    </div>
  );
}
