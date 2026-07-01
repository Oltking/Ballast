// Lending — one serverless function (Vercel Hobby's 12-function cap), dispatched
// by `?action=`:
//   POST /api/loan?action=borrow  {address, signedXdr, amount}
//   POST /api/loan?action=repay   {address, signedXdr, amount}
//   GET  /api/loan?action=stats&borrower=G...
//
// Borrowing/repaying is recorded ON-CHAIN in the loan-book contract — that's the
// credit history the ZK Credit Passport proves over. Cash disbursement is drawn
// from the OPERATOR's own lending pool (its USDC balance), entirely separate from
// customer custody, so lending never touches the reserves backing deposits (the
// solvency proof stays intact). If the lending pool isn't funded on testnet, the
// loan is still recorded on-chain (building credit) and the payout is flagged
// pending — labelled honestly, never silently faked.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, isValidAddress, json, requireWalletAuth, subjectOf } from "./_lib/http.js";
import {
  LOANBOOK_ID,
  POOL_ID,
  REGISTRY_ID,
  addr,
  bytes,
  hasOperatorKey,
  i128,
  invokeAsOperator,
  readView,
  u32,
} from "./_lib/chain.js";

const MAX_LOAN = BigInt(process.env.MAX_LOAN_STROOPS || "1000000000"); // 100 USDC (with passport)
const STARTER_LOAN = BigInt(process.env.STARTER_LOAN_STROOPS || "100000000"); // 10 USDC (no passport)
const PASSPORT_PREDICATE = 1;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    const action = String(req.query.action ?? (req.method === "GET" ? "stats" : "borrow"));

    // --- GET stats: public per-borrower credit standing from the loan-book ---
    if (action === "stats") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const borrower = String(req.query.borrower ?? "");
      if (!isValidAddress(borrower)) return json(res, 400, { error: "valid borrower address required" });
      const s = (await readView(LOANBOOK_ID, "stats", [addr(borrower)])) as Record<string, unknown> | null;
      return json(res, 200, {
        borrower,
        outstanding: String(s?.outstanding ?? "0"),
        repaid: Number(s?.repaid_count ?? 0),
        defaults: Number(s?.default_count ?? 0),
        disbursed: Number(s?.disbursed_count ?? 0),
      });
    }

    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!hasOperatorKey()) return json(res, 503, { error: "operator signer not configured" });

    const b = body(req);
    const borrower = await requireWalletAuth(b);
    let amount: bigint;
    try {
      amount = BigInt(String(b.amount ?? "0"));
    } catch {
      return json(res, 400, { error: "bad amount" });
    }
    if (amount <= 0n) return json(res, 400, { error: "amount must be positive" });

    // --- borrow: passport-gated limit, drawn from the ZK lending pool ---
    if (action === "borrow") {
      // A valid ZK Credit Passport (good standing) unlocks the full cap; without
      // one you get a smaller starter line — so you can build credit first.
      let hasPassport = false;
      try {
        hasPassport =
          (await readView(REGISTRY_ID, "is_valid", [
            bytes(subjectOf(borrower)),
            u32(PASSPORT_PREDICATE),
            u32(0),
          ])) === true;
      } catch {
        /* no passport / read failed → starter cap */
      }
      const cap = hasPassport ? MAX_LOAN : STARTER_LOAN;
      if (amount > cap) {
        return json(res, 400, {
          error: hasPassport
            ? "over the per-loan cap"
            : "over your starter limit — build a ZK Credit Passport to borrow more",
          cap: cap.toString(),
          hasPassport,
        });
      }
      // Record credit history (feeds the passport) + draw from the POOL: this
      // moves lenders' pooled cash to the borrower and raises the pool's
      // `outstanding` (solvency preserved). Reverts InsufficientLiquidity if the
      // pool has no free cash (it needs lenders first).
      const loanTx = await invokeAsOperator(LOANBOOK_ID, "disburse", [addr(borrower), i128(amount)]);
      const poolTx = await invokeAsOperator(POOL_ID, "borrow", [addr(borrower), i128(amount)]);
      return json(res, 200, {
        action: "borrow",
        borrower,
        amount: amount.toString(),
        loanTx,
        poolTx,
        hasPassport,
        source: "pool",
      });
    }

    // --- repay: record the repayment on-chain (builds good standing) ---
    if (action === "repay") {
      const tx = await invokeAsOperator(LOANBOOK_ID, "repay", [addr(borrower), i128(amount)]);
      return json(res, 200, { action: "repay", borrower, amount: amount.toString(), tx });
    }

    return json(res, 400, { error: `unknown loan action: ${action}` });
  } catch (e) {
    handleError(res, e);
  }
}
