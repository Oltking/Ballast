// GET /api/book → the PUBLIC view of the operator's private book: the committed
// liabilities root, the aggregate total L, the user count, and the live on-chain
// reserves / net_custodied for context. No per-user data — only the aggregate
// the solvency proof commits to.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, json } from "./_lib/http.ts";
import { bookSummary } from "./_lib/book.ts";
import { VAULT_ID, readView } from "./_lib/chain.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const summary = await bookSummary();
    let reserves = "0";
    let netCustodied = "0";
    try {
      reserves = String(await readView(VAULT_ID, "reserves"));
      netCustodied = String(await readView(VAULT_ID, "net_custodied"));
    } catch {
      /* chain read best-effort */
    }
    return json(res, 200, {
      liabilitiesRoot: summary.root,
      total: summary.total, // Σ balances = L (the aggregate; individual leaves stay private)
      count: summary.count,
      reserves,
      netCustodied,
    });
  } catch (e) {
    handleError(res, e);
  }
}
