// GET /api/passport/root → the issuer's published credit-record Merkle root (the
// registry predicate ANCHOR) + borrower count. Public: it's just the root.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, json } from "../_lib/http.ts";
import { creditRootHex } from "../_lib/credit.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const { root, count } = await creditRootHex();
    return json(res, 200, { root, count });
  } catch (e) {
    handleError(res, e);
  }
}
