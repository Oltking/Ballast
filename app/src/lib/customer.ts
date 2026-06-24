// Customer-side model for the "My account" dashboard.
//
// IMPORTANT (honest WIP): in the real product the custodian keeps the private
// per-user ledger and *issues* each customer their leaf (account, balance, salt)
// from it. There is no per-user balance on-chain — only the aggregate
// `net_custodied`. Here we **simulate the operator's private book in the browser**
// so a customer can experience the full lifecycle (claim → counted → covered)
// end-to-end. Deposits, withdrawals, provider solvency and history are read from
// / written to the *real* chain; the local book + salt issuance are the simulated
// part, and are labelled as such in the UI.

import { StrKey } from "@stellar/stellar-sdk";
import {
  buildSumTree,
  proveInclusion,
  hex,
  type InclusionProof,
  type Leaf,
} from "./sumtree.ts";
import { RESERVE_DECIMALS } from "./config.ts";

/** A Stellar account is an ed25519 key — decode the G-address to its 32 bytes,
 *  which is exactly the leaf's `account` field. Your wallet *is* your identity. */
export function accountBytes(address: string): number[] {
  return Array.from(StrKey.decodeEd25519PublicKey(address));
}

export function isValidAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

// mulberry32 — tiny deterministic PRNG so the demo book is stable across reloads.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededBytes(rand: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(rand() * 256));
  return out;
}
function hashAddr(a: string): number {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (Math.imul(31, h) + a.charCodeAt(i)) | 0;
  return h;
}

const ONE = 10n ** BigInt(RESERVE_DECIMALS);
export function toStroops(usdc: string): bigint {
  const [w, f = ""] = usdc.trim().split(".");
  const frac = (f + "0".repeat(RESERVE_DECIMALS)).slice(0, RESERVE_DECIMALS);
  return BigInt(w || "0") * ONE + BigInt(frac || "0");
}

/** Deterministic anonymized "rest of the book" — models the other customers in
 *  the provider's private ledger, so your inclusion path has real depth. */
export function demoPeers(count = 5): Leaf[] {
  const rand = rng(0x0ba11a57);
  const out: Leaf[] = [];
  for (let i = 0; i < count; i++) {
    const usdc = Math.floor(80 + rand() * 4200);
    out.push({
      account: seededBytes(rand, 32),
      balance: (BigInt(usdc) * ONE).toString(),
      salt: seededBytes(rand, 32),
    });
  }
  return out;
}

export type ClaimEvent = {
  kind: "issued" | "deposit" | "withdraw-request" | "withdraw";
  amount?: string; // stroops
  ts: number;
  tx?: string;
};

export type StoredClaim = {
  address: string;
  salt: number[]; // 32 — your private blinding factor (NOT a wallet secret)
  balance: string; // stroops, your custodied claim
  createdAt: number;
  events: ClaimEvent[];
};

const KEY = (addr: string) => `ballast.claim.${addr}`;

export function loadClaim(address: string): StoredClaim | null {
  try {
    const raw = localStorage.getItem(KEY(address));
    return raw ? (JSON.parse(raw) as StoredClaim) : null;
  } catch {
    return null;
  }
}

export function saveClaim(c: StoredClaim): void {
  try {
    localStorage.setItem(KEY(c.address), JSON.stringify(c));
  } catch {
    /* storage unavailable — claim is ephemeral this session */
  }
}

/** Issue (or re-load) the customer's claim ticket. The salt is derived
 *  deterministically from the address so a re-issue is stable in the demo. */
export function getOrIssueClaim(address: string): StoredClaim {
  const existing = loadClaim(address);
  if (existing) return existing;
  const rand = rng(hashAddr(address));
  const c: StoredClaim = {
    address,
    salt: seededBytes(rand, 32),
    balance: "0",
    createdAt: Date.now(),
    events: [{ kind: "issued", ts: Date.now() }],
  };
  saveClaim(c);
  return c;
}

export function claimLeaf(c: StoredClaim): Leaf {
  return { account: accountBytes(c.address), balance: c.balance, salt: c.salt };
}

/** The full simulated book = peers + your leaf (yours last). */
export function buildBook(c: StoredClaim): { book: Leaf[]; index: number } {
  const book = [...demoPeers(), claimLeaf(c)];
  return { book, index: book.length - 1 };
}

/** The fingerprint your provider would publish, and the proof your leaf is in it. */
export async function fingerprintAndProof(
  c: StoredClaim,
): Promise<{ root: string; total: bigint; proof: InclusionProof }> {
  const { book, index } = buildBook(c);
  const { root, total } = await buildSumTree(book);
  const proof = await proveInclusion(book, index);
  return { root: hex(root), total, proof };
}

/** Append an event and persist. Returns the updated claim. */
export function recordEvent(c: StoredClaim, ev: ClaimEvent): StoredClaim {
  const next = { ...c, events: [ev, ...c.events] };
  saveClaim(next);
  return next;
}
