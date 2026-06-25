// Shared "Get testnet USDC" onboarding — a 3-step checklist that walks a wallet
// from empty to deposit-ready: Friendbot XLM funding, a one-click USDC
// trustline, then a hand-off to Circle's faucet. Used by both the customer and
// operator dashboards. Pure presentation; the actions are passed in.

import type { UsdcStatus } from "../lib/assets.ts";

export default function UsdcOnboard({
  usdc,
  busy,
  waiting = false,
  onFund,
  onTrust,
  onFaucet,
  onRefresh,
}: {
  usdc: UsdcStatus;
  busy: string | null;
  waiting?: boolean;
  onFund: () => void;
  onTrust: () => void;
  onFaucet: () => void;
  onRefresh: () => void;
}) {
  const hasUsdc = Number(usdc.balance) > 0;
  return (
    <>
      <h2>Get testnet USDC</h2>
      <p className="sub">
        To deposit you need testnet USDC in your wallet. Three quick steps — all on Stellar testnet,
        no real money involved.
      </p>
      <ol className="claim-steps">
        <li className={usdc.funded ? "done" : "active"}>
          <span className="claim-ic" aria-hidden="true">{usdc.funded ? "✓" : "1"}</span>
          <div className="claim-body">
            <div className="claim-title">Activate your account with testnet XLM</div>
            <div className="claim-meta">
              {usdc.funded
                ? "Your account is active on the ledger."
                : "A fresh wallet needs XLM before it can hold assets."}
            </div>
            {!usdc.funded && (
              <button className="btn small" disabled={!!busy} onClick={onFund}>
                {busy === "fund" ? "Funding…" : "Fund with Friendbot"}
              </button>
            )}
          </div>
        </li>
        <li className={!usdc.funded ? "" : usdc.trustline ? "done" : "active"}>
          <span className="claim-ic" aria-hidden="true">{usdc.trustline ? "✓" : "2"}</span>
          <div className="claim-body">
            <div className="claim-title">Add a USDC trustline</div>
            <div className="claim-meta">
              {usdc.trustline
                ? "You can hold USDC."
                : "One-click — your wallet signs it. This lets you hold USDC."}
            </div>
            {usdc.funded && !usdc.trustline && (
              <button className="btn small" disabled={!!busy} onClick={onTrust}>
                {busy === "trust" ? "Signing…" : "Add USDC trustline"}
              </button>
            )}
          </div>
        </li>
        <li className={usdc.trustline ? "active" : ""}>
          <span className="claim-ic" aria-hidden="true">{hasUsdc ? "✓" : "3"}</span>
          <div className="claim-body">
            <div className="claim-title">Claim USDC from Circle's faucet</div>
            <div className="claim-meta">
              Circle issues this exact testnet USDC. We'll copy your address — paste it, pick
              <strong> Stellar testnet</strong>, and claim. Balance: <strong>{usdc.balance} USDC</strong>.
            </div>
            {usdc.trustline && (
              <>
                <div className="row">
                  <button className="btn small" onClick={onFaucet}>Get USDC from Circle ↗</button>
                  <button className="btn small secondary" disabled={!!busy} onClick={onRefresh}>
                    I've claimed — refresh
                  </button>
                </div>
                {waiting && !hasUsdc && (
                  <div className="claim-waiting">
                    <span className="spin" aria-hidden="true" /> Waiting for your USDC to arrive —
                    this picks up automatically the moment it lands (or hit refresh).
                  </div>
                )}
              </>
            )}
          </div>
        </li>
      </ol>
    </>
  );
}
