// GET /api/health → backend status: is the store durable, is the operator
// signer configured, basic book stats. Safe to expose (no secrets).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, json } from "./_lib/http.ts";
import { isDurable } from "./_lib/store.ts";
import { hasOperatorKey, operatorAddress } from "./_lib/chain.ts";
import { bookSummary } from "./_lib/book.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const summary = await bookSummary();
    return json(res, 200, {
      ok: true,
      durableStore: isDurable(),
      operatorConfigured: hasOperatorKey(),
      operator: hasOperatorKey() ? operatorAddress() : null,
      proverTokenSet: Boolean(process.env.PROVER_TOKEN),
      book: { count: summary.count, total: summary.total, root: summary.root },
    });
  } catch (e) {
    handleError(res, e);
  }
}
