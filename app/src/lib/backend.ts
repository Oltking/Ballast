// Typed client for the custodian backend (the real operator service under
// `app/api/`, same origin → `/api/...`). It holds the PRIVATE per-user book
// (balances + salts) and fulfils withdrawals on-chain with the operator key.
//
// Until the operator provisions it (Redis + OPERATOR_SECRET), `backendAvailable`
// resolves false and the dashboard degrades to the in-browser simulation in
// `customer.ts` — labelled honestly in the UI. When it IS provisioned, the
// dashboard talks to it for the user's real leaf, inclusion proof and redemptions.
//
// Auth for sensitive actions is a wallet-signed, one-time challenge TRANSACTION:
//   GET /api/auth-challenge?address=G… → { nonce, xdr }
//   sign `xdr` with the wallet → signedXdr
//   POST the action with { address, signedXdr, …fields }
// A challenge is consumed on use, so we fetch a fresh one before EACH authed POST.

import { signAuthChallenge } from "./wallet.ts";
import type { InclusionProof } from "./sumtree.ts";

const API = "/api";

export interface Health {
  ok: boolean;
  durableStore: boolean;
  operatorConfigured: boolean;
  operator: string | null;
  proverTokenSet: boolean;
  book: { count: number; total: string; root: string };
}

export interface PublicBook {
  liabilitiesRoot: string;
  total: string;
  count: number;
  reserves: string;
  netCustodied: string;
}

export interface AccountPublic {
  subject: string;
  balance: string; // stroops
  counted: boolean;
}

/** Your own leaf (auth-gated): balance in stroops, salt as 64-hex. */
export interface AccountLeaf {
  subject: string;
  address: string;
  balance: string;
  salt: string;
  counted: boolean;
}

export interface InclusionResult {
  counted: true;
  root: string; // hex of the published liabilities root
  proof: InclusionProof; // verifies with verifyInclusion()
}

export interface WithdrawResult {
  txHash: string;
  paidTo: string;
  amount: string;
  balance: string;
}

/** The published credit anchor (Merkle root over the passport records). */
export interface PassportRoot {
  root: string;
  count: number;
}

/** Result of rebuilding the private liabilities book from on-chain custody. */
export interface ReconcileResult {
  updated: number;
  root: string;
  total: string;
  count: number;
}

/** Result of deriving passport credit records from the loan-book. */
export interface PassportReconcileResult {
  updated: number;
  root: string;
  count: number;
}

/** Result of nudging the CI prover (debounced server-side). */
export interface ProveTriggerResult {
  triggered: boolean;
  reason?: string;
}

export type ProveWorkflow = "solvency" | "passport";

interface ApiError extends Error {
  status?: number;
  data?: unknown;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const err: ApiError = new Error(String(data?.error ?? `request failed (${r.status})`));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

export async function getHealth(): Promise<Health> {
  return getJson<Health>("/health");
}

export async function getPublicBook(): Promise<PublicBook> {
  return getJson<PublicBook>("/book");
}

export async function getAccountPublic(subject: string): Promise<AccountPublic> {
  return getJson<AccountPublic>(`/account?subject=${encodeURIComponent(subject)}`);
}

/** The published credit anchor (Merkle root + record count) for the passport. */
export async function getPassportRoot(): Promise<PassportRoot> {
  return getJson<PassportRoot>("/passport/root");
}

/** POST with no auth (public trigger). Shares the ApiError handling of getJson. */
async function postJson<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const err: ApiError = new Error(String(data?.error ?? `request failed (${r.status})`));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

let availability: Promise<boolean> | null = null;

/** Is the operator backend provisioned (signer configured + durable store)?
 *  Cached for the session; pass `force` to re-check. On any failure → false, so
 *  the deployed site keeps working on the simulation before the operator sets up. */
export function backendAvailable(force = false): Promise<boolean> {
  if (force) availability = null;
  availability ??= (async () => {
    try {
      const h = await getHealth();
      return Boolean(h.ok && h.operatorConfigured && h.durableStore);
    } catch {
      return false;
    }
  })();
  return availability;
}

/** Run the challenge → sign → POST flow for an authed action. Fetches a FRESH
 *  one-time challenge each call (the backend consumes it on use). */
async function authPost<T>(
  path: string,
  address: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const { xdr } = await getJson<{ nonce: string; xdr: string }>(
    `/auth-challenge?address=${encodeURIComponent(address)}`,
  );
  const signedXdr = await signAuthChallenge(xdr, address);
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ address, signedXdr, ...extra }),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const err: ApiError = new Error(String(data?.error ?? `request failed (${r.status})`));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

/** Ensure your account exists and reconcile your balance from on-chain custody,
 *  returning your real leaf (subject, balance, salt). */
export async function openAccount(address: string): Promise<AccountLeaf> {
  return authPost<AccountLeaf>("/account", address);
}

/** Your Merkle inclusion proof against the published root, or null if you're not
 *  in the book yet (404 `{counted:false}`). */
export async function getInclusion(address: string): Promise<InclusionResult | null> {
  try {
    return await authPost<InclusionResult>("/inclusion", address);
  } catch (e) {
    if ((e as ApiError)?.status === 404) return null;
    throw e;
  }
}

/** Authorize a redemption; the operator fulfils `withdraw_user(to=you, amount)`
 *  on-chain and pays your authenticated address. `amountStroops` is a string. */
export async function withdraw(address: string, amountStroops: string): Promise<WithdrawResult> {
  return authPost<WithdrawResult>("/withdraw", address, { amount: amountStroops });
}

// ---- Operator/admin actions (wallet-auth: challenge → sign → POST) ----

/** Rebuild the private liabilities book from on-chain custody. Admin-only —
 *  `address` must be the backend's configured operator/admin. */
export async function reconcileBook(address: string): Promise<ReconcileResult> {
  return authPost<ReconcileResult>("/reconcile", address);
}

/** Derive credit records from the on-chain loan-book and re-anchor the passport
 *  Merkle root. Admin-only. */
export async function reconcilePassport(address: string): Promise<PassportReconcileResult> {
  return authPost<PassportReconcileResult>("/passport/reconcile", address);
}

/** Manually record an issuer credit record for a borrower (optional; the
 *  loan-book path via `reconcilePassport` is preferred). `address` authenticates
 *  as the operator/admin; `borrower` is the subject the record is keyed to. */
export async function enrollBorrower(
  address: string,
  borrower: string,
  repaid: number,
  defaults: number,
): Promise<PassportReconcileResult> {
  return authPost<PassportReconcileResult>("/passport/enroll", address, {
    subject: borrower,
    repaid,
    defaults,
  });
}

/** Nudge the CI prover for a workflow. No auth; the server debounces so a recent
 *  run returns `{triggered:false, reason:"debounced"}`. */
export async function proveTrigger(workflow: ProveWorkflow): Promise<ProveTriggerResult> {
  return postJson<ProveTriggerResult>("/prove-trigger", { workflow });
}

// ---- Lending (loan-book) ----

/** A borrower's public credit standing, read from the on-chain loan-book. This
 *  is the history the ZK Credit Passport proves over. Amounts are in stroops. */
export interface LoanStats {
  borrower: string;
  outstanding: string;
  repaid: number;
  defaults: number;
  disbursed: number;
}

/** Result of recording a loan on-chain. `paid` is false when the operator
 *  lending pool isn't funded — the loan is still recorded (building credit) and
 *  `note` explains the pending cash payout. */
export interface BorrowResult {
  borrower: string;
  amount: string;
  loanTx: string;
  paid: boolean;
  payTx: string | null;
  note?: string;
}

/** Result of recording a repayment on-chain. */
export interface RepayResult {
  borrower: string;
  amount: string;
  tx: string;
}

/** Public per-borrower credit standing from the loan-book (no auth). */
export async function getLoanStats(borrower: string): Promise<LoanStats> {
  return getJson<LoanStats>(`/loan?action=stats&borrower=${encodeURIComponent(borrower)}`);
}

/** Record a loan on-chain and disburse from the operator lending pool if funded.
 *  Wallet-authed; `amountStroops` is a string. Per-loan cap is 100 USDC. */
export async function borrow(address: string, amountStroops: string): Promise<BorrowResult> {
  return authPost<BorrowResult>("/loan?action=borrow", address, { amount: amountStroops });
}

/** Record a repayment on-chain (builds good standing). Wallet-authed. The USDC
 *  transfer to the operator must be done separately before calling this. */
export async function repay(address: string, amountStroops: string): Promise<RepayResult> {
  return authPost<RepayResult>("/loan?action=repay", address, { amount: amountStroops });
}
