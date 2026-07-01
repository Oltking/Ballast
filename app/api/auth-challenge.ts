// GET /api/auth-challenge?address=G... → { nonce, xdr }
// The client signs `xdr` (a never-submittable challenge transaction) with the
// wallet's `signTransaction`, then POSTs { address, signedXdr } to authenticate
// account/withdraw/inclusion for ~5 minutes, one-time use.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, isValidAddress, issueChallenge, json } from "./_lib/http.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    const address = String(req.query.address ?? "");
    if (!isValidAddress(address)) return json(res, 400, { error: "valid G... address required" });
    const challenge = await issueChallenge(address);
    return json(res, 200, challenge);
  } catch (e) {
    handleError(res, e);
  }
}
