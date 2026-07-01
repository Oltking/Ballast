// GET /api/book-leaves  (header: x-prover-token: <PROVER_TOKEN>)
// Returns the FULL private book in canonical order — every leaf (account, balance,
// salt) — so the off-chain prover can rebuild the exact sum-tree the vault
// records and prove `reserves >= L >= net_custodied`. This is the operator's
// private ledger; it is gated by the shared PROVER_TOKEN and never sent to
// browsers. The CI prover holds the token as a repo secret.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, json, requireProverToken } from "./_lib/http.js";
import { loadBookLeaves } from "./_lib/book.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    requireProverToken(req);
    const leaves = await loadBookLeaves();
    return json(res, 200, { leaves, count: leaves.length });
  } catch (e) {
    handleError(res, e);
  }
}
