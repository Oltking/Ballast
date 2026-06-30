// POST /api/inclusion  {address,nonce,signature} → auth'd.
// Returns the caller's own Merkle inclusion proof (leaf + path) against the
// current published liabilities root, so they can verify locally that they are
// counted in the book the operator proves solvent. Only the caller's own leaf is
// revealed (auth-gated), never anyone else's.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireWalletAuth, subjectOf } from "./_lib/http.ts";
import { inclusionForSubject } from "./_lib/book.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const address = await requireWalletAuth(body(req));
    const subject = subjectOf(address);
    const result = await inclusionForSubject(subject);
    if (!result) return json(res, 404, { counted: false, error: "not in the book yet" });
    return json(res, 200, { counted: true, root: result.root, proof: result.proof });
  } catch (e) {
    handleError(res, e);
  }
}
