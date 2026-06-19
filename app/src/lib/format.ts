import { RESERVE_DECIMALS } from "./config";

/** stroops (1e-7) -> human string with thousands separators. */
export function fmtAmount(stroops: bigint): string {
  const neg = stroops < 0n;
  let v = neg ? -stroops : stroops;
  const base = 10n ** BigInt(RESERVE_DECIMALS);
  const whole = v / base;
  const frac = v % base;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fracStr = frac.toString().padStart(RESERVE_DECIMALS, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + wholeStr + (fracStr ? "." + fracStr : "");
}

export function fmtBps(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2) + "%";
}

export function bytesToHex(b: Uint8Array | number[] | undefined): string {
  if (!b) return "";
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export function shortHex(h: string, head = 8, tail = 6): string {
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function shortId(id: string): string {
  return shortHex(id, 6, 6);
}
