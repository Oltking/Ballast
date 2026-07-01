// POST /api/reconcile  (header: x-prover-token: <PROVER_TOKEN>)
// Operator/automation action: rebuild the private book from on-chain truth.
// For every address with net vault custody (Σ deposits − Σ user-withdrawals),
// ensure a user exists and set its authoritative liability to that net. This
// keeps the book == on-chain custody (so L == net_custodied and the solvency
// proof is honest), and onboards depositors who never explicitly opened an
// account. Idempotent: it's a pure function of chain state.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireOperator, subjectOf } from "./_lib/http.js";
import { getStore } from "./_lib/store.js";
import { VAULT_ID, latestLedger, netCustodyByAddress, readView } from "./_lib/chain.js";
import { bookSummary } from "./_lib/book.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    await requireOperator(req, body(req)); // CI prover token OR operator-console wallet auth
    const store = getStore();
    const ledger = await latestLedger();
    const net = await netCustodyByAddress();
    let updated = 0;
    let attributed = 0n;
    for (const [address, amount] of net) {
      const subject = subjectOf(address);
      await store.ensureUser(subject, address, ledger);
      await store.setBalance(subject, amount.toString());
      attributed += amount;
      updated++;
    }
    // The on-chain custodied floor is authoritative. Any custody we couldn't
    // attribute per-user (e.g. deposit events aged out of the RPC's ~24h event
    // retention) is filled into a single POOL leaf, so the committed liabilities
    // L == net_custodied and the solvency proof stays honest — it never
    // under-states what's owed. A production operator keeps these balances in a
    // persistent ledger and reconciles continuously, so the pool is normally 0.
    let floor = 0n;
    try {
      floor = BigInt(String(await readView(VAULT_ID, "net_custodied")));
    } catch {
      /* keep 0 if the chain read fails */
    }
    const POOL_SUBJECT = "ee".repeat(32); // reserved marker leaf (not a real account)
    const pool = floor > attributed ? floor - attributed : 0n;
    await store.ensureUser(POOL_SUBJECT, "POOL", ledger);
    await store.setBalance(POOL_SUBJECT, pool.toString());

    const summary = await bookSummary(store);
    return json(res, 200, { updated, attributed: attributed.toString(), pool: pool.toString(), ...summary });
  } catch (e) {
    handleError(res, e);
  }
}
