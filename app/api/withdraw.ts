// POST /api/withdraw  {address,nonce,signature,amount}
// The user authorizes a redemption by signing a challenge; the operator backend
// validates it against the private book and FULFILS it on-chain by signing
// `withdraw_user(to=address, amount)` with the operator key. Funds always go to
// the authenticated account. Users can always exit (the vault never gates user
// redemptions on solvency/staleness).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { body, cors, handleError, json, requireWalletAuth, subjectOf } from "./_lib/http.js";
import { getStore } from "./_lib/store.js";
import { VAULT_ID, addr, hasOperatorKey, i128, invokeAsOperator } from "./_lib/chain.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (cors(req, res)) return;
  try {
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!hasOperatorKey()) return json(res, 503, { error: "operator signer not configured" });

    const b = body(req);
    const address = await requireWalletAuth(b);
    const subject = subjectOf(address);

    let amount: bigint;
    try {
      amount = BigInt(String(b.amount ?? "0"));
    } catch {
      return json(res, 400, { error: "bad amount" });
    }
    if (amount <= 0n) return json(res, 400, { error: "amount must be positive" });

    const store = getStore();
    // Serialize withdrawals per user so two concurrent requests can't both clear
    // the balance check before either debits.
    if (!(await store.acquireOnce(`wd:${subject}`, 20))) {
      return json(res, 429, { error: "a withdrawal is already in progress — try again in a moment" });
    }
    const user = await store.getUser(subject);
    const balance = BigInt(user?.balance ?? "0");
    if (amount > balance) {
      return json(res, 400, { error: "amount exceeds your balance", balance: balance.toString() });
    }

    // Operator fulfils the redemption on-chain.
    const txHash = await invokeAsOperator(VAULT_ID, "withdraw_user", [addr(address), i128(amount)]);

    // Record the withdrawal authoritatively (ahead of the event index) and debit,
    // so reconcile's max(events, recorded) rule never re-credits the spent amount.
    await store.addWithdrawn(subject, amount);
    await store.setBalance(subject, (balance - amount).toString());

    return json(res, 200, {
      txHash,
      paidTo: address,
      amount: amount.toString(),
      balance: (balance - amount).toString(),
    });
  } catch (e) {
    handleError(res, e);
  }
}
