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
import { body, cors, handleError, isValidAddress, json, requireWalletAuth } from "./_lib/http.js";
import {
  LOANBOOK_ID,
  USDC_SAC,
  addr,
  hasOperatorKey,
  i128,
  invokeAsOperator,
  operatorAddress,
  readView,
  tokenBalance,
} from "./_lib/chain.js";

const MAX_LOAN = BigInt(process.env.MAX_LOAN_STROOPS || "1000000000"); // 100 USDC

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

    // --- borrow: record the loan on-chain, then disburse if the pool is funded ---
    if (action === "borrow") {
      if (amount > MAX_LOAN) {
        return json(res, 400, { error: "over the per-loan cap", cap: MAX_LOAN.toString() });
      }
      const loanTx = await invokeAsOperator(LOANBOOK_ID, "disburse", [addr(borrower), i128(amount)]);
      // Disburse from the operator lending pool, if funded (never from custody).
      let payTx: string | null = null;
      let paid = false;
      const pool = await tokenBalance(operatorAddress());
      if (pool >= amount) {
        payTx = await invokeAsOperator(USDC_SAC, "transfer", [
          addr(operatorAddress()),
          addr(borrower),
          i128(amount),
        ]);
        paid = true;
      }
      return json(res, 200, {
        action: "borrow",
        borrower,
        amount: amount.toString(),
        loanTx,
        paid,
        payTx,
        note: paid
          ? undefined
          : "loan recorded on-chain (building your credit); cash payout pending a funded lending pool",
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
