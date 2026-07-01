// POST /api/passport/reconcile  (x-prover-token OR operator wallet auth)
// Derive the issuer credit book from the ON-CHAIN loan-book contract: discover
// every borrower from its events and set each one's (repaid, defaults) from the
// contract's authoritative `stats`. This makes the passport's record contents
// chain-anchored (verifiable loan/repayment events) rather than hand-entered —
// the honest upgrade over manual enrollment. Returns the new published root so
// the caller can roll the registry anchor.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireOperator, subjectOf } from "../_lib/http.ts";
import { getStore } from "../_lib/store.ts";
import { getLoanbookBorrowers, loanbookStats } from "../_lib/chain.ts";
import { creditRootHex } from "../_lib/credit.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    await requireOperator(req, body(req));
    const store = getStore();
    const borrowers = await getLoanbookBorrowers();
    let updated = 0;
    for (const address of borrowers) {
      const subject = subjectOf(address);
      const { repaid, defaults } = await loanbookStats(address);
      await store.ensureBorrower(subject, address);
      await store.setBorrower(subject, repaid, defaults);
      updated++;
    }
    const { root, count } = await creditRootHex(store);
    return json(res, 200, { updated, root, count });
  } catch (e) {
    handleError(res, e);
  }
}
