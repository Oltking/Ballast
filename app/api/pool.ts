// ZK lending pool — one serverless function (Vercel Hobby's 12-function cap),
// dispatched by `?action=`. The pool is a provably-solvent vault whose assets =
// cash + outstanding loans; lenders' positions live in a SECOND private book
// (mirroring custody). Solvency (`assets >= Σ lender_claims`) is proven with the
// SAME ZK guest, so lenders are provably covered without revealing positions.
//
//   GET  /api/pool?action=state                      → pool solvency + book (public)
//   POST /api/pool?action=position {address,signedXdr} → your lender leaf
//   POST /api/pool?action=inclusion {address,signedXdr}→ your inclusion proof
//   POST /api/pool?action=redeem {address,signedXdr,amount} → operator-fulfilled lender withdrawal
//   POST /api/pool?action=reconcile  (operator/token)  → rebuild pool book from chain
//   GET  /api/pool?action=leaves     (prover token)    → pool book for the prover

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  body,
  cors,
  handleError,
  json,
  requireOperator,
  requireProverToken,
  requireWalletAuth,
  subjectOf,
} from "./_lib/http.js";
import { getStore } from "./_lib/store.js";
import {
  POOL_ID,
  addr,
  hasOperatorKey,
  i128,
  invokeAsOperator,
  latestLedger,
  poolFlowsByAddress,
  readView,
} from "./_lib/chain.js";
import { loadPoolLeaves, poolBookSummary, poolInclusionForSubject } from "./_lib/book.js";

const s = (v: unknown) => String(v ?? "0");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    const action = String(req.query.action ?? "state");
    const store = getStore();

    // ---- GET state: the pool's live solvency + the published lender book ----
    if (action === "state") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const [cred, cash, outstanding, pooled, assets, surplus, epoch, fresh] = await Promise.all([
        readView(POOL_ID, "solvency_credential").catch(() => null),
        readView(POOL_ID, "cash").catch(() => 0),
        readView(POOL_ID, "outstanding").catch(() => 0),
        readView(POOL_ID, "pooled").catch(() => 0),
        readView(POOL_ID, "assets").catch(() => 0),
        readView(POOL_ID, "surplus").catch(() => 0),
        readView(POOL_ID, "epoch").catch(() => 0),
        readView(POOL_ID, "attestation_fresh").catch(() => false),
      ]);
      const c = cred as Record<string, unknown> | null;
      const credential = c
        ? {
            solvent: Boolean(c.solvent),
            ratio_bps: Number(c.ratio_bps ?? 0),
            epoch: Number(c.epoch ?? 0),
            ledger: Number(c.ledger ?? 0),
            margin: s(c.margin),
            fresh: Boolean(c.fresh),
            status: typeof c.status === "object" ? c.status : Number(c.status ?? 0),
          }
        : null;
      return json(res, 200, {
        cash: s(cash),
        outstanding: s(outstanding),
        pooled: s(pooled),
        assets: s(assets),
        surplus: s(surplus),
        epoch: Number(epoch),
        fresh: Boolean(fresh),
        credential,
        book: await poolBookSummary(store),
      });
    }

    // ---- GET leaves: full pool book for the prover ----
    if (action === "leaves") {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      requireProverToken(req);
      const leaves = await loadPoolLeaves(store);
      return json(res, 200, { leaves, count: leaves.length });
    }

    // ---- POST reconcile: rebuild the lender book from pool events ----
    if (action === "reconcile") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      await requireOperator(req, body(req));
      const ledger = await latestLedger();
      const flows = await poolFlowsByAddress();
      let attributed = 0n;
      for (const [address, f] of flows) {
        const subject = subjectOf(address);
        await store.ensureLender(subject, address, ledger);
        const recorded = await store.getLenderWithdrawn(subject);
        const spent = f.withdrawals > recorded ? f.withdrawals : recorded;
        let bal = f.deposits - spent;
        if (bal < 0n) bal = 0n;
        await store.setLenderBalance(subject, bal.toString());
        attributed += bal;
      }
      // Fill any unattributed lender claims (events aged out) into a pool leaf,
      // so L == pooled (the on-chain lender-claims floor) and the proof is honest.
      let floor = 0n;
      try {
        floor = BigInt(s(await readView(POOL_ID, "pooled")));
      } catch {
        /* keep 0 */
      }
      const FILLER = "dd".repeat(32);
      const fill = floor > attributed ? floor - attributed : 0n;
      await store.ensureLender(FILLER, "POOL", ledger);
      await store.setLenderBalance(FILLER, fill.toString());
      return json(res, 200, { updated: flows.size, attributed: attributed.toString(), fill: fill.toString(), ...(await poolBookSummary(store)) });
    }

    // ---- POST position: this lender's own leaf (auth) ----
    if (action === "position") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const b = body(req);
      const address = await requireWalletAuth(b);
      const subject = subjectOf(address);
      const ledger = await latestLedger();
      const lender = await store.ensureLender(subject, address, ledger);
      const f = (await poolFlowsByAddress()).get(address) ?? { deposits: 0n, withdrawals: 0n };
      const recorded = await store.getLenderWithdrawn(subject);
      const spent = f.withdrawals > recorded ? f.withdrawals : recorded;
      let bal = f.deposits - spent;
      if (bal < 0n) bal = 0n;
      await store.setLenderBalance(subject, bal.toString());
      return json(res, 200, { subject, address, balance: bal.toString(), salt: lender.salt, counted: bal > 0n });
    }

    // ---- POST inclusion: this lender's inclusion proof (auth) ----
    if (action === "inclusion") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const address = await requireWalletAuth(body(req));
      const result = await poolInclusionForSubject(subjectOf(address), store);
      if (!result) return json(res, 404, { counted: false, error: "not in the pool book yet" });
      return json(res, 200, { counted: true, root: result.root, proof: result.proof });
    }

    // ---- POST redeem: operator-fulfilled lender withdrawal (auth) ----
    if (action === "redeem") {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!hasOperatorKey()) return json(res, 503, { error: "operator signer not configured" });
      const b = body(req);
      const address = await requireWalletAuth(b);
      const subject = subjectOf(address);
      let amount: bigint;
      try {
        amount = BigInt(s(b.amount));
      } catch {
        return json(res, 400, { error: "bad amount" });
      }
      if (amount <= 0n) return json(res, 400, { error: "amount must be positive" });
      if (!(await store.acquireOnce(`redeem:${subject}`, 20))) {
        return json(res, 429, { error: "a redemption is already in progress — try again shortly" });
      }
      const lender = await store.getLender(subject);
      const balance = BigInt(lender?.balance ?? "0");
      if (amount > balance) {
        return json(res, 400, { error: "amount exceeds your lender balance", balance: balance.toString() });
      }
      // Operator fulfils the redemption on-chain (traps InsufficientLiquidity if
      // the funds are lent out — the lender must wait for repayments).
      const txHash = await invokeAsOperator(POOL_ID, "lender_withdraw", [addr(address), i128(amount)]);
      await store.addLenderWithdrawn(subject, amount);
      await store.setLenderBalance(subject, (balance - amount).toString());
      return json(res, 200, { txHash, paidTo: address, amount: amount.toString(), balance: (balance - amount).toString() });
    }

    return json(res, 404, { error: `unknown pool action: ${action}` });
  } catch (e) {
    handleError(res, e);
  }
}
