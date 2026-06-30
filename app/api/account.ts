// GET  /api/account?subject=<hex>   → public, minimal (subject, balance, counted)
// POST /api/account  {address,nonce,signature} → auth'd; ensures the user's
//   account, reconciles their balance from on-chain custody, returns their leaf
//   (subject, balance, salt) so they can verify inclusion locally.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireWalletAuth, subjectOf } from "./_lib/http.ts";
import { getStore } from "./_lib/store.ts";
import { latestLedger, netCustodyByAddress } from "./_lib/chain.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    const store = getStore();
    if (req.method === "GET") {
      const subject = String(req.query.subject ?? "").toLowerCase();
      if (!subject) return json(res, 400, { error: "subject required" });
      const u = await store.getUser(subject);
      return json(res, 200, {
        subject,
        balance: u?.balance ?? "0",
        counted: Boolean(u && BigInt(u.balance) > 0n),
      });
    }
    if (req.method === "POST") {
      const b = body(req);
      const address = await requireWalletAuth(b);
      const subject = subjectOf(address);
      const ledger = await latestLedger();
      const user = await store.ensureUser(subject, address, ledger);
      // Reconcile this user's authoritative liability to their net on-chain custody.
      const net = (await netCustodyByAddress()).get(address) ?? 0n;
      await store.setBalance(subject, net.toString());
      return json(res, 200, {
        subject,
        address,
        balance: net.toString(),
        salt: user.salt,
        counted: net > 0n,
      });
    }
    return json(res, 405, { error: "method not allowed" });
  } catch (e) {
    handleError(res, e);
  }
}
