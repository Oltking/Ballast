// USDC readiness for a customer: does the account exist (XLM-funded), does it
// hold a trustline to the reserve USDC, and what's the balance. All read from
// Horizon — no wallet/signature needed. Plus a friendbot helper to XLM-fund a
// fresh account so it can hold a trustline at all.

import { Horizon } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, HORIZON_URL, USDC_CODE, USDC_ISSUER } from "./config.ts";

const horizon = new Horizon.Server(HORIZON_URL);

export type UsdcStatus = {
  funded: boolean; // account exists on the ledger (has XLM)
  trustline: boolean; // holds a trustline to the reserve USDC
  balance: string; // USDC balance, human units (e.g. "100.0000000")
};

/** Is this wallet ready to deposit — funded, trustlined, and holding USDC? */
export function usdcReady(u: UsdcStatus | null): boolean {
  return !!u && u.funded && u.trustline && Number(u.balance) > 0;
}

type CreditBalance = { asset_code?: string; asset_issuer?: string; balance: string };

export async function usdcStatus(address: string): Promise<UsdcStatus> {
  try {
    const acc = await horizon.loadAccount(address);
    const bal = (acc.balances as unknown as CreditBalance[]).find(
      (b) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
    );
    return { funded: true, trustline: !!bal, balance: bal?.balance ?? "0" };
  } catch {
    // 404 = account not yet created on the ledger (needs XLM funding first).
    return { funded: false, trustline: false, balance: "0" };
  }
}

/** XLM-fund a fresh testnet account via friendbot so it can hold assets. */
export async function fundWithFriendbot(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
  if (!res.ok) {
    // friendbot 400s if the account already exists — treat that as success.
    const body = await res.text().catch(() => "");
    if (!/already.*funded|op_already_exists|exists/i.test(body)) {
      throw new Error("friendbot funding failed");
    }
  }
}
