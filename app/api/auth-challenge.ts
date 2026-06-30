// GET /api/auth-challenge?address=G... → { nonce }
// The client signs `nonce` (UTF-8) with the wallet; the signature authenticates
// subsequent POSTs (account, withdraw, inclusion) for ~5 minutes, one-time use.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, isValidAddress, issueChallenge, json } from "./_lib/http.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const address = String(req.query.address ?? "");
    if (!isValidAddress(address)) return json(res, 400, { error: "valid G... address required" });
    const nonce = await issueChallenge(address);
    return json(res, 200, { nonce });
  } catch (e) {
    handleError(res, e);
  }
}
