// POST /api/passport/enroll  (header: x-prover-token)
// Issuer/operator action: record (or update) a borrower's credit history
// {address, repaid, defaults}. The contents are issuer-attested — that's the
// stated Tier-2 trust assumption for the passport. Returns the new published
// root so the caller can roll the registry anchor.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireProverToken, subjectOf, isValidAddress } from "../_lib/http.ts";
import { getStore } from "../_lib/store.ts";
import { creditRootHex } from "../_lib/credit.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    requireProverToken(req);
    const b = body(req);
    const address = String(b.address ?? "");
    if (!isValidAddress(address)) return json(res, 400, { error: "valid G... address required" });
    const repaid = Math.max(0, Math.floor(Number(b.repaid ?? 0)));
    const defaults = Math.max(0, Math.floor(Number(b.defaults ?? 0)));
    const store = getStore();
    const subject = subjectOf(address);
    await store.ensureBorrower(subject, address);
    await store.setBorrower(subject, repaid, defaults);
    const { root, count } = await creditRootHex(store);
    return json(res, 200, { subject, repaid, defaults, root, count });
  } catch (e) {
    handleError(res, e);
  }
}
