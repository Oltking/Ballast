// GET /api/passport/record?subject=<hex>  → public, minimal: is this subject
// enrolled in the issuer's book. The repaid/default counts stay PRIVATE (the
// whole point — they only ever surface as a ZK verdict via the registry).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, json } from "../_lib/http.ts";
import { getStore } from "../_lib/store.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const subject = String(req.query.subject ?? "").toLowerCase();
    if (!subject) return json(res, 400, { error: "subject required" });
    const b = await getStore().getBorrower(subject);
    return json(res, 200, { subject, enrolled: Boolean(b) });
  } catch (e) {
    handleError(res, e);
  }
}
