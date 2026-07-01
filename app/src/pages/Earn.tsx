// Earn — the LENDER surface for the ZK lending pool. Lenders supply USDC into a
// PRIVATE per-lender position; the pool proves `assets = cash + outstanding ≥ Σ
// lender_claims` in zero-knowledge, so every lender is provably covered without
// revealing their position. Borrowers draw from this same pool, gated by their
// ZK Credit Passport. Testnet prototype.
import { useCallback, useEffect, useMemo, useState } from "react";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { addressArg, readView, type Attestation } from "../lib/stellar.ts";
import { addTrustline, invoke } from "../lib/wallet.ts";
import { useWallet } from "../lib/wallet-context.tsx";
import { toStroops } from "../lib/customer.ts";
import {
  fundWithFriendbot,
  usdcReady,
  usdcStatus,
  type UsdcStatus,
} from "../lib/assets.ts";
import {
  getPoolState,
  poolInclusion,
  poolPosition,
  poolRedeem,
  type PoolPosition,
  type PoolState,
} from "../lib/backend.ts";
import { hexToBytes, verifyInclusion, type InclusionProof } from "../lib/sumtree.ts";
import {
  CIRCLE_FAUCET_URL,
  ISSUER_NAME,
  POOL_ID,
  USDC_CODE,
  USDC_ISSUER,
  contractUrl,
  txUrl,
} from "../lib/config.ts";
import { errMsg, fmtAmount, shortHex } from "../lib/format.ts";
import UsdcOnboard from "../components/UsdcOnboard.tsx";

// Covered "yes"/"no" against the live book; scope tells us whether the same leaf
// is already inside the ON-CHAIN proven attestation root, or only the live book.
type Covered = "yes" | "no" | null;
type CoveredScope = "attested" | "live" | null;

interface CoverBadge {
  cls: string;
  label: string;
  line: string;
}

function coverBadge(state: PoolState | null): CoverBadge {
  if (!state) return { cls: "gray", label: "—", line: "Loading pool status…" };
  const c = state.credential;
  if (!c) {
    return {
      cls: "gray",
      label: "Attestation pending",
      line: "The pool hasn't published its first solvency proof yet — nothing to take on trust.",
    };
  }
  if (!c.solvent) {
    return {
      cls: "red",
      label: "Backing not confirmed",
      line: "The latest proof did not confirm the pool covers every lender — treat with caution.",
    };
  }
  const fresh = c.fresh || state.fresh;
  if (!fresh) {
    return {
      cls: "amber",
      label: "Proof refreshing",
      line: `Covered at epoch ${c.epoch}; a fresh proof is due. Your right to redeem is unaffected.`,
    };
  }
  return {
    cls: "green",
    label: "✓ Provably covered",
    line: `Assets proven to cover every lender's claim at epoch ${c.epoch} — checked live on Stellar.`,
  };
}

export default function Earn() {
  // Shared wallet — connect once anywhere and this section is already connected.
  const {
    address: addr,
    walletNet,
    wrongNetwork,
    connect,
    disconnect: disconnectWallet,
    refreshNetwork,
  } = useWallet();

  const [state, setState] = useState<PoolState | null>(null);
  const [position, setPosition] = useState<PoolPosition | null>(null);

  const [supplyAmt, setSupplyAmt] = useState("100");
  const [redeemAmt, setRedeemAmt] = useState("25");

  const [covered, setCovered] = useState<Covered>(null);
  const [coveredScope, setCoveredScope] = useState<CoveredScope>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const [usdc, setUsdc] = useState<UsdcStatus | null>(null);
  const [waitingForUsdc, setWaitingForUsdc] = useState(false);

  const walletNetName = walletNet.startsWith("Public") ? "Mainnet (Public)" : "a non-testnet network";

  const refreshState = useCallback(async () => {
    try {
      setState(await getPoolState());
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  const refreshPosition = useCallback(async (a: string) => {
    try {
      setPosition(await poolPosition(a));
    } catch {
      // The operator backend may not be provisioned — leave the position empty.
      setPosition(null);
    }
  }, []);

  const checkUsdc = useCallback(async (a: string) => {
    try {
      setUsdc(await usdcStatus(a));
    } catch {
      setUsdc(null);
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (!addr) return;
    void refreshPosition(addr);
    void checkUsdc(addr);
  }, [addr, refreshPosition, checkUsdc]);

  // After sending the user to the faucet, auto-resume: poll for the USDC landing.
  useEffect(() => {
    if (!waitingForUsdc || !addr) return;
    if (usdc && usdcReady(usdc)) {
      setWaitingForUsdc(false);
      return;
    }
    const recheck = () => {
      if (document.visibilityState === "visible") void checkUsdc(addr);
    };
    const id = window.setInterval(recheck, 6000);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [waitingForUsdc, addr, usdc, checkUsdc]);

  function disconnect() {
    disconnectWallet();
    setPosition(null);
    setCovered(null);
    setCoveredScope(null);
    setLastTx(null);
    setErr(null);
    setUsdc(null);
    setWaitingForUsdc(false);
  }

  async function recheckNetwork() {
    await refreshNetwork();
    if (addr) void checkUsdc(addr);
  }

  // ---- USDC onboarding helpers (same flow as Account deposits) ----
  async function fundXlm() {
    if (!addr) return;
    setBusy("fund");
    setErr(null);
    try {
      await fundWithFriendbot(addr);
      await checkUsdc(addr);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function addUsdcTrust() {
    if (!addr) return;
    setBusy("trust");
    setErr(null);
    setLastTx(null);
    try {
      const tx = await addTrustline(addr, USDC_CODE, USDC_ISSUER);
      setLastTx(tx);
      for (let i = 0; i < 6; i++) {
        const st = await usdcStatus(addr);
        setUsdc(st);
        if (st.trustline) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  function openFaucet() {
    if (addr) void navigator.clipboard?.writeText(addr).catch(() => {});
    setWaitingForUsdc(true);
    window.open(CIRCLE_FAUCET_URL, "_blank", "noopener,noreferrer");
  }

  // ---- supply liquidity ----
  async function supply() {
    if (!addr) return;
    const stroops = toStroops(supplyAmt);
    if (stroops <= 0n) {
      setErr("enter a positive amount");
      return;
    }
    setBusy("supply");
    setErr(null);
    setLastTx(null);
    try {
      const tx = await invoke(
        addr,
        "lender_deposit",
        [addressArg(addr), nativeToScVal(stroops.toString(), { type: "i128" })],
        POOL_ID,
      );
      setLastTx(tx);
      // Attribute the deposit to your private lender leaf, then refresh views.
      await poolPosition(addr).catch(() => null);
      await refreshState();
      await refreshPosition(addr);
      void checkUsdc(addr);
      setCovered(null);
      setCoveredScope(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  // ---- am I covered? ----
  async function checkCovered() {
    if (!addr) return;
    setBusy("covered");
    setErr(null);
    try {
      const incl = await poolInclusion(addr);
      if (!incl) {
        setCovered("no");
        setCoveredScope(null);
        return;
      }
      const proof: InclusionProof = incl.proof;
      const okBook = await verifyInclusion(proof, hexToBytes(incl.root));
      // Also fold the SAME proof against the on-chain proven attestation root, so
      // we can tell "already inside the proof" from "in the live book, next proof".
      let okOnChain = false;
      try {
        const att = (await readView("latest_attestation", [], POOL_ID)) as Attestation | null;
        if (att?.liabilities_root) {
          okOnChain = await verifyInclusion(proof, att.liabilities_root);
        }
      } catch {
        /* no attestation yet — treat as live-only */
      }
      setCovered(okBook ? "yes" : "no");
      setCoveredScope(okBook ? (okOnChain ? "attested" : "live") : null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  // ---- redeem ----
  async function redeem() {
    if (!addr) return;
    const stroops = toStroops(redeemAmt);
    if (stroops <= 0n) {
      setErr("enter a positive amount");
      return;
    }
    if (position && stroops > BigInt(position.balance)) {
      setErr("amount exceeds your supplied balance");
      return;
    }
    setBusy("redeem");
    setErr(null);
    setLastTx(null);
    try {
      const r = await poolRedeem(addr, stroops.toString());
      setLastTx(r.txHash);
      await refreshState();
      await refreshPosition(addr);
      void checkUsdc(addr);
    } catch (e) {
      const msg = errMsg(e);
      setErr(
        /InsufficientLiquidity|insufficient.*liquid/i.test(msg)
          ? "Some of the pool's funds are lent out right now — your position is redeemable as borrowers repay. Try a smaller amount or check back soon."
          : msg,
      );
    } finally {
      setBusy(null);
    }
  }

  const badge = coverBadge(state);
  const pooled = state ? BigInt(state.pooled) : 0n;
  const cash = state ? BigInt(state.cash) : 0n;
  const outstanding = state ? BigInt(state.outstanding) : 0n;
  const surplus = state ? BigInt(state.surplus) : 0n;
  const supplied = position ? BigInt(position.balance) : 0n;

  const usdcBalanceNum = usdc ? Number(usdc.balance) : 0;
  const needsUsdc = useMemo(
    () => !!addr && !wrongNetwork && !!usdc && !usdcReady(usdc) && usdcBalanceNum === 0,
    [addr, wrongNetwork, usdc, usdcBalanceNum],
  );

  // ---- not connected ----
  if (!addr) {
    return (
      <section className="panel" style={{ maxWidth: 640, margin: "20px auto", textAlign: "center" }}>
        <h3>Earn</h3>
        <p style={{ color: "var(--muted)" }}>
          Supply USDC to the community lending pool and earn yield as borrowers repay. Your position
          stays private; the pool is proven solvent so you're always provably covered. Connect your
          wallet to get started.
        </p>
        {err && <div className="error mt">⚠ {err}</div>}
        <div className="trust-cta" style={{ justifyContent: "center", marginTop: 14 }}>
          <button className="btn primary" onClick={() => void connect()}>Connect wallet</button>
        </div>
      </section>
    );
  }

  // ---- connected ----
  return (
    <>
      <div className="page-head">
        <div className="issuer-id" style={{ marginBottom: 0 }}>
          <span className="issuer-logo">H</span>
          <span className="issuer-meta">
            <span className="issuer-name">{ISSUER_NAME}</span>
            <br />
            <span className="issuer-kind">earn · ZK lending pool · Stellar testnet</span>
          </span>
        </div>
        <span className="wallet-chip">
          <span className="wallet-dot" />
          {shortHex(addr, 6, 6)}
          <button className="linklike" onClick={disconnect}>change</button>
        </span>
      </div>

      {wrongNetwork && (
        <div className="net-warn">
          <div className="net-warn-title">⚠ Your wallet is on {walletNetName} — switch it to <strong>Testnet</strong></div>
          <p>
            This app runs entirely on the Stellar <strong>test</strong> network (play money). Change
            your wallet's network to <strong>Testnet</strong>, then re-check.
          </p>
          <button className="btn small" onClick={() => void recheckNetwork()}>I've switched — re-check</button>
        </div>
      )}
      {err && <div className="error">⚠ {err}</div>}
      {lastTx && (
        <div className="tx-ok">
          ✓ settled ·{" "}
          <a href={txUrl(lastTx)} target="_blank" rel="noreferrer" className="mono">{shortHex(lastTx, 10, 6)}</a>
        </div>
      )}

      {/* the pool, provably covered */}
      <div className="panel">
        <h2>The pool, provably covered</h2>
        <p className="sub">{badge.line}</p>
        <div className="grid">
          <div className="stat">
            <div className="label">Total supplied</div>
            <div className="value">{fmtAmount(pooled)} USDC</div>
          </div>
          <div className="stat">
            <div className="label">Available cash</div>
            <div className="value">{fmtAmount(cash)} USDC</div>
          </div>
          <div className="stat">
            <div className="label">Lent out</div>
            <div className="value">{fmtAmount(outstanding)} USDC</div>
          </div>
          <div className="stat">
            <div className="label">Coverage</div>
            <div className="value"><span className={`pill ${badge.cls}`}>{badge.label}</span></div>
          </div>
        </div>
        <p className="small muted mt">
          The pool's assets are <strong>cash + loans outstanding</strong>, and the same zero-knowledge
          proof that backs accounts proves <span className="mono">assets ≥ Σ lender_claims</span> —
          so every lender is covered without revealing anyone's position. Accrued yield (surplus):{" "}
          <strong>{fmtAmount(surplus)} USDC</strong>.{" "}
          <a href={contractUrl(POOL_ID)} target="_blank" rel="noreferrer">View the pool contract ↗</a>
        </p>
      </div>

      {/* get testnet USDC — onboarding helper */}
      {needsUsdc && supplied === 0n && (
        <div className="panel">
          <UsdcOnboard
            usdc={usdc as UsdcStatus}
            busy={busy}
            waiting={waitingForUsdc}
            onFund={() => void fundXlm()}
            onTrust={() => void addUsdcTrust()}
            onFaucet={openFaucet}
            onRefresh={() => addr && void checkUsdc(addr)}
          />
        </div>
      )}

      {/* supply liquidity */}
      <div className="panel">
        <h2>Supply liquidity</h2>
        <p className="sub">
          Move USDC into the community lending pool. You authorize this yourself — the custodian never
          holds your key. Your supply becomes a <strong>private</strong> per-lender position and puts
          your cash to work backing borrowers.
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC)</span>
            <input type="text" value={supplyAmt} onChange={(e) => setSupplyAmt(e.target.value)} />
          </label>
          <button className="btn" disabled={!!busy || wrongNetwork} onClick={() => void supply()}>
            {busy === "supply" ? "Supplying…" : "Supply"}
          </button>
        </div>
        {usdc && (
          <p className="small muted mt">
            You have <strong>{usdc.balance} USDC</strong> in your wallet
            {usdcBalanceNum > 0 ? (
              <>
                {" · "}
                <button className="linklike" onClick={() => setSupplyAmt(usdc.balance.replace(/\.?0+$/, ""))}>
                  supply max
                </button>
              </>
            ) : (
              !wrongNetwork && (
                <>
                  {" · "}
                  <button className="linklike" onClick={openFaucet}>get more from the faucet ↗</button>
                </>
              )
            )}
            . You need a USDC trustline + balance to supply — the same as an Account deposit.
          </p>
        )}
      </div>

      {/* your position */}
      <div className="panel">
        <h2>Your position</h2>
        <p className="sub">
          Your supplied balance is private — nobody sees it, but you can prove for yourself that
          you're counted in the pool's books, the same way the ZK proof folds your leaf.
        </p>
        <div className="acct-strip">
          <div className="acct-stat">
            <div className="label">You're counted for</div>
            <div className="value big-num">${fmtAmount(supplied)}</div>
          </div>
          <div className="acct-stat">
            <div className="label">Covered by the proof</div>
            <div className="value">
              {covered === "yes" ? <span className="pill green">YES ✓</span>
                : covered === "no" ? <span className="pill red">NO ✗</span>
                : <span className="pill gray">check below</span>}
            </div>
          </div>
        </div>

        {covered === "yes" && (
          <div className="verdict solvent mt">
            <div className="dot" />
            <div>
              <div className="big">
                {coveredScope === "attested"
                  ? "✓ Covered in the on-chain proof"
                  : "✓ Covered in the live book"}
              </div>
              <div className="note">
                {coveredScope === "attested"
                  ? "Your position folds to the liabilities root proven on-chain — you are inside the pool's latest solvency proof. The pool can't drop you without changing a fingerprint everyone can see."
                  : "Your position folds to the operator's live book; it differs from the last on-chain proof, so you'll be included in the next attestation (the next proof will cover it)."}
              </div>
            </div>
          </div>
        )}
        {covered === "no" && (
          <div className="verdict bad mt">
            <div className="dot" />
            <div>
              <div className="big">✗ Not in the pool book yet</div>
              <div className="note">Supply liquidity first — once your deposit is attributed, your leaf folds into the pool's fingerprint.</div>
            </div>
          </div>
        )}

        <div className="row check-actions mt" style={{ justifyContent: "flex-start" }}>
          <button
            className="btn primary"
            onClick={() => void checkCovered()}
            disabled={!!busy}
          >
            {busy === "covered" ? "Folding…" : "Am I covered?"}
          </button>
          {position && (
            <span className="small muted" style={{ alignSelf: "center" }}>
              salt (secret): <span className="mono">{shortHex(position.salt, 8, 6)}</span>
            </span>
          )}
        </div>
      </div>

      {/* redeem */}
      <div className="panel">
        <h2>Redeem</h2>
        <p className="sub">
          Withdraw from your position. You authorize the redemption with a wallet signature and the
          operator pays your address on-chain from the pool's cash. If funds are lent out, your
          redemption waits for borrowers to repay — you're always provably covered for the full amount.
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC){supplied > 0n ? ` — up to your ${fmtAmount(supplied)} supplied` : ""}</span>
            <input type="text" value={redeemAmt} onChange={(e) => setRedeemAmt(e.target.value)} />
          </label>
          <button className="btn" disabled={!!busy || wrongNetwork} onClick={() => void redeem()}>
            {busy === "redeem" ? "Redeeming…" : "Redeem"}
          </button>
        </div>
      </div>

      <p className="small muted center">
        Your position is <strong>private</strong>; the pool is proven solvent (
        <span className="mono">assets = cash + outstanding ≥ everyone's claims</span>), so lenders are
        provably covered without revealing anyone's book. Borrowers are gated by their ZK Credit
        Passport. This is a testnet prototype.
      </p>
    </>
  );
}
