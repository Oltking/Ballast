// POST /api/reconcile  (header: x-prover-token: <PROVER_TOKEN>)
// Operator/automation action: rebuild the private book from on-chain truth.
// For every address with net vault custody (Σ deposits − Σ user-withdrawals),
// ensure a user exists and set its authoritative liability to that net. This
// keeps the book == on-chain custody (so L == net_custodied and the solvency
// proof is honest), and onboards depositors who never explicitly opened an
// account. Idempotent: it's a pure function of chain state.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireOperator, subjectOf } from "./_lib/http.ts";
import { getStore } from "./_lib/store.ts";
import { latestLedger, netCustodyByAddress } from "./_lib/chain.ts";
import { bookSummary } from "./_lib/book.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    await requireOperator(req, body(req)); // CI prover token OR operator-console wallet auth
    const store = getStore();
    const ledger = await latestLedger();
    const net = await netCustodyByAddress();
    let updated = 0;
    for (const [address, amount] of net) {
      const subject = subjectOf(address);
      await store.ensureUser(subject, address, ledger);
      await store.setBalance(subject, amount.toString());
      updated++;
    }
    const summary = await bookSummary(store);
    return json(res, 200, { updated, ...summary });
  } catch (e) {
    handleError(res, e);
  }
}
