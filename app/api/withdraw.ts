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
    const user = await store.getUser(subject);
    const balance = BigInt(user?.balance ?? "0");
    if (amount > balance) {
      return json(res, 400, { error: "amount exceeds your balance", balance: balance.toString() });
    }

    // Operator fulfils the redemption on-chain.
    const txHash = await invokeAsOperator(VAULT_ID, "withdraw_user", [addr(address), i128(amount)]);

    // Optimistically debit; the next reconcile re-derives from chain truth.
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
