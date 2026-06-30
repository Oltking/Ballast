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
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { getStore } from "./store.ts";

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

/** Issue a one-time challenge the client must sign to prove key ownership. */
export async function issueChallenge(address: string): Promise<string> {
  const nonce = `ballast-auth:${address}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await getStore().putChallenge(address, nonce, 300);
  return nonce;
}

export type AuthBody = { address?: string; nonce?: string; signature?: string };

/** Verify a signed challenge. Returns the authenticated address, or throws. */
export async function requireWalletAuth(body: AuthBody): Promise<string> {
  const { address, nonce, signature } = body;
  if (!address || !nonce || !signature) throw new HttpError(401, "missing auth fields");
  if (!isValidAddress(address)) throw new HttpError(400, "bad address");
  const stored = await getStore().takeChallenge(address);
  if (!stored || stored !== nonce) throw new HttpError(401, "challenge expired or mismatched");
  let ok = false;
  try {
    ok = Keypair.fromPublicKey(address).verify(Buffer.from(nonce, "utf8"), Buffer.from(signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, "signature verification failed");
  return address;
}

export function requireProverToken(req: VercelRequest): void {
  const tok = req.headers["x-prover-token"];
  const expected = process.env.PROVER_TOKEN;
  if (!expected) throw new HttpError(503, "PROVER_TOKEN not configured");
  if (tok !== expected) throw new HttpError(401, "bad prover token");
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
