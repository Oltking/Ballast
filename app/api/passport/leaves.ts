// GET /api/passport/leaves  (header: x-prover-token)
// The full issuer credit book in canonical order — every record (subject,
// repaid, defaults, salt) — for the passport prover to rebuild the exact Merkle
// tree it proves inclusion against. Gated by PROVER_TOKEN; never sent to browsers.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors, handleError, json, requireProverToken } from "../_lib/http.ts";
import { loadBorrowerRecords } from "../_lib/credit.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    requireProverToken(req);
    const records = await loadBorrowerRecords();
    return json(res, 200, {
      records: records.map((r) => ({
        subject: r.subject,
        repaid: r.repaid,
        defaults: r.defaults,
        salt: r.salt,
      })),
      count: records.length,
    });
  } catch (e) {
    handleError(res, e);
  }
}
