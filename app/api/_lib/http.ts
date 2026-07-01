// Tiny HTTP helpers + auth for the serverless API.
//
// Auth model:
//  - Sensitive user actions (open account, withdraw, see your inclusion proof)
//    require a wallet signature over a one-time challenge nonce — so only the
//    holder of the account's key can act on it. Server verifies ed25519 directly,
//    so it works for any Stellar key (Freighter `signMessage` on the client).
//  - The private book leaves endpoint (the prover needs the whole book) is gated
//    by a shared PROVER_TOKEN header, never exposed to browsers.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { getStore } from "./store.js";
import { NETWORK_PASSPHRASE, hasOperatorKey, operatorAddress } from "./chain.js";

export function json(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.send(JSON.stringify(body));
}

export function cors(req: VercelRequest, res: VercelResponse): boolean {
  res.setHeader("access-control-allow-origin", process.env.ALLOW_ORIGIN || "*");
  res.setHeader("access-control-allow-headers", "content-type, x-prover-token");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

export function subjectOf(address: string): string {
  return Buffer.from(StrKey.decodeEd25519PublicKey(address)).toString("hex");
}

export function isValidAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

const CHALLENGE_DATA_NAME = "ballast-auth";

/** Issue a one-time SEP-10-style challenge TRANSACTION the client signs with its
 *  wallet (`signTransaction`, supported by every wallet — unlike `signMessage`).
 *  The tx carries the nonce in a manage_data op and is never submittable
 *  (sequence 0); we only verify the signature on it. */
export async function issueChallenge(address: string): Promise<{ nonce: string; xdr: string }> {
  const nonce = randHex(24); // ≤ 64 bytes for manage_data value
  const tx = new TransactionBuilder(new Account(address, "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.manageData({ name: CHALLENGE_DATA_NAME, value: Buffer.from(nonce, "utf8") }),
    )
    .setTimeout(300)
    .build();
  await getStore().putChallenge(address, nonce, 300);
  return { nonce, xdr: tx.toXDR() };
}

function randHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type AuthBody = { address?: string; signedXdr?: string };

/** Verify a signed challenge transaction. Returns the authenticated address, or
 *  throws. Checks: source == address, the manage_data nonce matches the one we
 *  issued (one-time), and a valid signature by the account's key over the tx. */
export async function requireWalletAuth(body: AuthBody): Promise<string> {
  const { address, signedXdr } = body;
  if (!address || !signedXdr) throw new HttpError(401, "missing auth fields");
  if (!isValidAddress(address)) throw new HttpError(400, "bad address");

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  } catch {
    throw new HttpError(400, "bad challenge xdr");
  }
  if (!(tx instanceof Transaction)) throw new HttpError(400, "expected a plain transaction");
  if (tx.source !== address) throw new HttpError(401, "challenge source mismatch");
  const op = tx.operations.find(
    (o) => o.type === "manageData" && o.name === CHALLENGE_DATA_NAME,
  ) as { value?: Buffer } | undefined;
  const nonce = op?.value ? op.value.toString("utf8") : "";
  if (!nonce) throw new HttpError(401, "challenge nonce missing");

  const stored = await getStore().takeChallenge(address);
  if (!stored || stored !== nonce) throw new HttpError(401, "challenge expired or mismatched");

  const kp = Keypair.fromPublicKey(address);
  const h = tx.hash();
  const ok = tx.signatures.some((sig) => {
    try {
      return kp.verify(h, sig.signature());
    } catch {
      return false;
    }
  });
  if (!ok) throw new HttpError(401, "signature verification failed");
  return address;
}

export function requireProverToken(req: VercelRequest): void {
  const tok = req.headers["x-prover-token"];
  const expected = process.env.PROVER_TOKEN;
  if (!expected) throw new HttpError(503, "PROVER_TOKEN not configured");
  if (tok !== expected) throw new HttpError(401, "bad prover token");
}

/** The set of addresses allowed to act as the operator from a browser console:
 *  the operator key's own public key, plus any `ADMIN_ADDRESS` (comma list). */
function adminAddresses(): string[] {
  const list: string[] = [];
  if (hasOperatorKey()) {
    try {
      list.push(operatorAddress());
    } catch {
      /* ignore */
    }
  }
  for (const a of (process.env.ADMIN_ADDRESS || "").split(",")) {
    if (a.trim()) list.push(a.trim());
  }
  return list;
}

/** Authenticate an operator/admin via a wallet-signed challenge, then check the
 *  address is an allowed admin. For browser operator-console actions. */
export async function requireAdminAuth(body: AuthBody): Promise<string> {
  const address = await requireWalletAuth(body);
  if (!adminAddresses().includes(address)) throw new HttpError(403, "not an operator");
  return address;
}

/** Operator-or-machine: a valid `x-prover-token` header (CI/automation) OR an
 *  admin wallet signature (operator console). Returns "prover" or the address. */
export async function requireOperator(req: VercelRequest, body: AuthBody): Promise<string> {
  if (req.headers["x-prover-token"]) {
    requireProverToken(req);
    return "prover";
  }
  return requireAdminAuth(body);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function handleError(res: VercelResponse, e: unknown): void {
  if (e instanceof HttpError) {
    json(res, e.status, { error: e.message });
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api]", msg);
    json(res, 500, { error: msg });
  }
}

export function body(req: VercelRequest): Record<string, unknown> {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body as Record<string, unknown>;
}
