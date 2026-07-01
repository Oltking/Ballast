// Credit-passport issuer endpoints, consolidated into ONE serverless function
// (Vercel Hobby caps a deployment at 12 functions). Dispatched by `?action=`.
// A rewrite in vercel.json maps the friendly paths to this:
//   /api/passport/root      -> ?action=root
//   /api/passport/record    -> ?action=record
//   /api/passport/enroll    -> ?action=enroll
//   /api/passport/leaves    -> ?action=leaves
//   /api/passport/reconcile -> ?action=reconcile

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  body,
  cors,
  handleError,
  isValidAddress,
  json,
  requireOperator,
  requireProverToken,
  subjectOf,
} from "./_lib/http.js";
import { getStore } from "./_lib/store.js";
import { creditRootHex, loadBorrowerRecords } from "./_lib/credit.js";
import { getLoanbookBorrowers, loanbookStats } from "./_lib/chain.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    const action = String(req.query.action ?? "root");
    const store = getStore();

    // --- GET /api/passport/root : the published credit anchor + count ---
    if (action === "root") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      return json(res, 200, await creditRootHex(store));
    }

    // --- GET /api/passport/record?subject= : is this subject enrolled ---
    if (action === "record") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const subject = String(req.query.subject ?? "").toLowerCase();
      if (!subject) return json(res, 400, { error: "subject required" });
      const b = await store.getBorrower(subject);
      return json(res, 200, { subject, enrolled: Boolean(b) });
    }

    // --- GET /api/passport/leaves : full issuer book for the prover (token) ---
    if (action === "leaves") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      requireProverToken(req);
      const records = await loadBorrowerRecords(store);
      return json(res, 200, {
        records: records.map((r) => ({
          subject: r.subject,
          repaid: r.repaid,
          defaults: r.defaults,
          salt: r.salt,
        })),
        count: records.length,
      });
    }

    // --- POST /api/passport/enroll : issuer records a borrower (operator) ---
    if (action === "enroll") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const b = body(req);
      await requireOperator(req, b);
      const borrower = String(b.borrower ?? b.subject ?? "");
      if (!isValidAddress(borrower)) return json(res, 400, { error: "valid borrower G... address required" });
      const repaid = Math.max(0, Math.floor(Number(b.repaid ?? 0)));
      const defaults = Math.max(0, Math.floor(Number(b.defaults ?? 0)));
      const subject = subjectOf(borrower);
      await store.ensureBorrower(subject, borrower);
      await store.setBorrower(subject, repaid, defaults);
      const { root, count } = await creditRootHex(store);
      return json(res, 200, { subject, repaid, defaults, root, count });
    }

    // --- POST /api/passport/reconcile : derive records from the loan-book ---
    if (action === "reconcile") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      await requireOperator(req, body(req));
      const borrowers = await getLoanbookBorrowers();
      let updated = 0;
      for (const address of borrowers) {
        const subject = subjectOf(address);
        const { repaid, defaults } = await loanbookStats(address);
        await store.ensureBorrower(subject, address);
        await store.setBorrower(subject, repaid, defaults);
        updated++;
      }
      const { root, count } = await creditRootHex(store);
      return json(res, 200, { updated, root, count });
    }

    return json(res, 404, { error: `unknown passport action: ${action}` });
  } catch (e) {
    handleError(res, e);
  }
}
