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

// Vault contract error codes (mirror contracts/vault/src/lib.rs Error enum).
const VAULT_ERRORS: Record<number, string> = {
  1: "vault not initialized",
  2: "vault already initialized",
  3: "invalid amount",
  4: "insufficient custodied balance",
  5: "arithmetic overflow",
  6: "invalid config",
  7: "bad proof journal",
  8: "domain mismatch",
  9: "epoch mismatch",
  10: "reserves mismatch",
  11: "net-custodied mismatch",
  12: "ratio mismatch",
  13: "insolvent",
  14: "no attestation yet",
  15: "stale attestation",
  16: "solvency breach",
  17: "insufficient reserves",
  18: "wind-down locked",
  19: "credential unavailable",
};

/** Best-effort human message out of whatever the SDK / wallet / RPC throws. */
export function errMsg(e: unknown): string {
  if (e == null) return "unknown error";
  if (typeof e === "string") return prettify(e);
  if (e instanceof Error) return prettify(e.message || e.toString());
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    // common nesting from stellar-sdk / wallets-kit
    for (const k of ["message", "error", "detail", "title"]) {
      const v = o[k];
      if (typeof v === "string" && v) return prettify(v);
    }
    if (o.result || o.errorResult) {
      try {
        return prettify(JSON.stringify(o.result ?? o.errorResult));
      } catch {
        /* fall through */
      }
    }
    try {
      const s = JSON.stringify(o);
      if (s && s !== "{}") return prettify(s);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

function prettify(raw: string): string {
  // Token transfer / trustline issues are the usual deposit failure — check
  // these before the contract-code map so a SAC error isn't mislabeled.
  if (/trustline|trust line|no trust|missing.*trustline/i.test(raw))
    return "no USDC trustline on this wallet — add the USDC asset (USDC:GBBD47IF…) and fund it on testnet first.";
  if (/insufficient/i.test(raw) && /balance/i.test(raw))
    return "insufficient USDC balance on this wallet for that amount.";
  // Surface a known *vault* contract error code if the diagnostic names one.
  const m = /Error\(Contract,\s*#(\d+)\)/.exec(raw);
  if (m) {
    const code = Number(m[1]);
    if (VAULT_ERRORS[code]) return `${VAULT_ERRORS[code]} (contract error #${code})`;
  }
  return raw.length > 240 ? raw.slice(0, 240) + "…" : raw;
}
