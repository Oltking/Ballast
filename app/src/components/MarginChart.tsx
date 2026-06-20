import type { MarginPoint } from "../lib/stellar.ts";
import { fmtAmount } from "../lib/format.ts";

// Simple dependency-free SVG trend of solvency margin (reserves − net_custodied)
// per epoch. Crossing below zero is the danger zone (red).
export default function MarginChart({ points }: { points: MarginPoint[] }) {
  if (points.length === 0) {
    return <p className="muted small">No attestations yet — the margin feed populates as proofs are posted.</p>;
  }
  const W = 640;
  const H = 160;
  const pad = 28;
  const margins = points.map((p) => Number(p.reserves - p.net_custodied));
  const max = Math.max(...margins, 1);
  const min = Math.min(...margins, 0);
  const span = max - min || 1;
  const x = (i: number) =>
    pad + (points.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (points.length - 1));
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const zeroY = y(0);

  const line = margins.map((m, i) => `${x(i)},${y(m)}`).join(" ");
  const lastNeg = margins[margins.length - 1] < 0;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="solvency margin trend">
        {/* zero / danger line */}
        <line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} stroke="var(--red)" strokeDasharray="4 4" strokeWidth="1" opacity="0.6" />
        <text x={W - pad} y={zeroY - 4} fill="var(--red)" fontSize="10" textAnchor="end">danger (margin = 0)</text>
        <polyline
          points={line}
          fill="none"
          stroke={lastNeg ? "var(--red)" : "var(--green)"}
          strokeWidth="2"
        />
        {margins.map((m, i) => (
          <circle key={i} cx={x(i)} cy={y(m)} r="3" fill={m < 0 ? "var(--red)" : "var(--green)"} />
        ))}
      </svg>
      <div className="kv">
        <span className="k">latest margin (reserves − floor)</span>
        <span className="v">{fmtAmount(points[points.length - 1].reserves - points[points.length - 1].net_custodied)}</span>
      </div>
      <div className="kv">
        <span className="k">epochs shown</span>
        <span className="v">{points[0].epoch}–{points[points.length - 1].epoch}</span>
      </div>
    </div>
  );
}
