// Loans — the on-ramp that BUILDS your Credit Passport. Borrowing and repaying
// are recorded on-chain in the loan-book contract; that credit history is what
// the ZK Credit Passport proves over. Cash is drawn from the ZK lending pool
// (lenders' supplied liquidity, provably covered) — never customer deposits, so
// the solvency proof backing accounts is untouched. Borrowing is passport-gated:
// a valid ZK Credit Passport unlocks the full cap; without one you get a smaller
// starter line so you can build credit first.
import { useCallback, useEffect, useState } from "react";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { addressArg } from "../lib/stellar.ts";
import { invoke } from "../lib/wallet.ts";
import { useWallet } from "../lib/wallet-context.tsx";
import { toStroops } from "../lib/customer.ts";
import {
  borrow as backendBorrow,
  getLoanStats,
  repay as backendRepay,
  type LoanStats,
} from "../lib/backend.ts";
import { ISSUER_NAME, POOL_ID, txUrl } from "../lib/config.ts";
import { errMsg, fmtAmount, shortHex } from "../lib/format.ts";

// 100 USDC per-loan cap with a passport; 10 USDC starter line without one
// (mirrors the backend MAX_LOAN / STARTER_LOAN).
const LOAN_CAP = 100n;
const STARTER_CAP = 10n;

interface LastTx {
  hash: string;
  label: string;
}

export default function Loans({ onNeedPassport }: { onNeedPassport?: () => void }) {
  // Wallet connection comes from the shared context — connect once anywhere and
  // this section is already connected, no second prompt.
  const {
    address: addr,
    walletNet,
    wrongNetwork,
    connect,
    disconnect: disconnectWallet,
    refreshNetwork,
  } = useWallet();

  const [stats, setStats] = useState<LoanStats | null>(null);
  const [borrowAmt, setBorrowAmt] = useState("10");
  const [repayAmt, setRepayAmt] = useState("10");
  // Set true when the backend reports a valid passport on a borrow (unlocks the
  // full cap); null until we've borrowed at least once this session.
  const [hasPassport, setHasPassport] = useState<boolean | null>(null);
  // True when the last borrow error was "over your starter limit" — prompt the
  // user to build a passport.
  const [overStarter, setOverStarter] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<LastTx | null>(null);

  const walletNetName = walletNet.startsWith("Public") ? "Mainnet (Public)" : "a non-testnet network";

  const refreshStats = useCallback(async (a: string) => {
    try {
      setStats(await getLoanStats(a));
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  function disconnect() {
    disconnectWallet();
    setStats(null);
    setLastTx(null);
    setNote(null);
    setErr(null);
    setHasPassport(null);
    setOverStarter(false);
  }

  // Load standing once connected.
  useEffect(() => {
    if (!addr) return;
    void refreshStats(addr);
  }, [addr, refreshStats]);

  async function doBorrow() {
    if (!addr) return;
    const stroops = toStroops(borrowAmt);
    if (stroops <= 0n) {
      setErr("enter a positive amount");
      return;
    }
    if (stroops > LOAN_CAP * 10n ** 7n) {
      setErr(`the per-loan cap is ${LOAN_CAP} USDC`);
      return;
    }
    setBusy("borrow");
    setErr(null);
    setNote(null);
    setLastTx(null);
    setOverStarter(false);
    try {
      const r = await backendBorrow(addr, stroops.toString());
      setLastTx({ hash: r.loanTx, label: "loan recorded on-chain · drawn from the community pool" });
      setHasPassport(r.hasPassport);
      await refreshStats(addr);
    } catch (e) {
      // Passport-gated cap: the backend returns { cap, hasPassport } and an
      // error naming the starter limit. Surface that + a build-a-passport nudge.
      const data = (e as { data?: { cap?: string; hasPassport?: boolean } })?.data;
      if (data && typeof data.hasPassport === "boolean") setHasPassport(data.hasPassport);
      if (data && data.hasPassport === false && data.cap) {
        setOverStarter(true);
        setErr(
          `Over your ${STARTER_CAP} USDC starter limit — build a ZK Credit Passport to borrow up to ${LOAN_CAP} USDC.`,
        );
      } else {
        // The pool may have no lenders yet → InsufficientLiquidity. Surface it
        // honestly rather than as an opaque contract error.
        const msg = errMsg(e);
        setErr(
          /InsufficientLiquidity|insufficient.*liquid/i.test(msg)
            ? "The community pool has no free cash right now — someone needs to supply liquidity in Earn (or wait for borrowers to repay)."
            : msg,
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function doRepay() {
    if (!addr) return;
    const stroops = toStroops(repayAmt);
    if (stroops <= 0n) {
      setErr("enter a positive amount");
      return;
    }
    setBusy("repay");
    setErr(null);
    setNote(null);
    setLastTx(null);
    try {
      // Real pool repayment: the borrower pays the pool directly on-chain
      // (reducing its `outstanding` and returning cash to lenders), then the
      // repayment is recorded in the loan-book (builds good standing). If the
      // on-chain payment fails (e.g. no USDC in the wallet) we surface a readable
      // error and record nothing.
      const tx = await invoke(
        addr,
        "repay",
        [addressArg(addr), nativeToScVal(stroops.toString(), { type: "i128" })],
        POOL_ID,
      );
      setLastTx({ hash: tx, label: "repaid the pool on-chain" });
      await backendRepay(addr, stroops.toString());
      await refreshStats(addr);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  // ---- not connected ----
  if (!addr) {
    return (
      <section className="panel" style={{ maxWidth: 640, margin: "20px auto", textAlign: "center" }}>
        <h3>Loans</h3>
        <p style={{ color: "var(--muted)" }}>
          Borrow and repay to build your on-chain credit standing — the history your ZK Credit
          Passport proves over. Connect your wallet to get started.
        </p>
        {err && <div className="error mt">⚠ {err}</div>}
        <div className="trust-cta" style={{ justifyContent: "center", marginTop: 14 }}>
          <button className="btn primary" onClick={() => void connect()}>Connect wallet</button>
        </div>
      </section>
    );
  }

  const outstanding = stats ? BigInt(stats.outstanding) : 0n;
  const currentCap = hasPassport ? LOAN_CAP : STARTER_CAP;

  // ---- connected ----
  return (
    <>
      <div className="page-head">
        <div className="issuer-id" style={{ marginBottom: 0 }}>
          <span className="issuer-logo">H</span>
          <span className="issuer-meta">
            <span className="issuer-name">{ISSUER_NAME}</span>
            <br />
            <span className="issuer-kind">loans · Stellar testnet</span>
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
          <button className="btn small" onClick={() => void refreshNetwork()}>I've switched — re-check</button>
        </div>
      )}
      {err && <div className="error">⚠ {err}</div>}
      {note && <div className="banner">ℹ {note}</div>}
      {lastTx && (
        <div className="tx-ok">
          ✓ {lastTx.label} ·{" "}
          <a href={txUrl(lastTx.hash)} target="_blank" rel="noreferrer" className="mono">{shortHex(lastTx.hash, 10, 6)}</a>
        </div>
      )}

      {/* credit standing */}
      <div className="panel">
        <h2>Your credit standing</h2>
        <p className="sub">
          Read live from the on-chain loan-book. This history powers your{" "}
          <strong>Credit Passport</strong> — a zero-knowledge proof of good standing you can show
          without revealing the underlying record.
        </p>
        <div className="grid">
          <div className="stat">
            <div className="label">Loans repaid</div>
            <div className="value">{stats ? stats.repaid : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Defaults</div>
            <div className="value">{stats ? stats.defaults : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Outstanding</div>
            <div className="value">{stats ? fmtAmount(outstanding) + " USDC" : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Loans taken</div>
            <div className="value">{stats ? stats.disbursed : "—"}</div>
          </div>
        </div>
      </div>

      {/* borrow */}
      <div className="panel">
        <h2>Borrow</h2>
        <p className="sub">
          Draw cash from the <strong>community lending pool</strong> — liquidity supplied by lenders
          in Earn, provably covered. The loan is recorded on-chain in the loan-book (building your
          credit). Borrowing is <strong>passport-gated</strong>: a valid ZK Credit Passport unlocks
          up to {LOAN_CAP.toString()} USDC per loan; without one you get a {STARTER_CAP.toString()}{" "}
          USDC starter line so you can build credit first.
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC) — up to {currentCap.toString()}</span>
            <input type="text" value={borrowAmt} onChange={(e) => setBorrowAmt(e.target.value)} />
          </label>
          <button className="btn" disabled={!!busy || wrongNetwork} onClick={() => void doBorrow()}>
            {busy === "borrow" ? "Borrowing…" : "Borrow"}
          </button>
        </div>
        <p className="small muted mt">
          {hasPassport === true ? (
            <>✓ Your ZK Credit Passport is unlocking the full {LOAN_CAP.toString()} USDC per-loan cap.</>
          ) : (
            <>
              Current limit: <strong>{currentCap.toString()} USDC</strong> per loan.
              {onNeedPassport && (
                <>
                  {" "}
                  <button className="linklike" onClick={onNeedPassport}>
                    Build a Credit Passport to borrow more →
                  </button>
                </>
              )}
            </>
          )}
        </p>
        {overStarter && onNeedPassport && (
          <div className="banner">
            🎫 <strong>Want a bigger line?</strong> A ZK Credit Passport proves your good standing and
            raises your cap to {LOAN_CAP.toString()} USDC.{" "}
            <button className="linklike" onClick={onNeedPassport}>
              Go to Credit Passport →
            </button>
          </div>
        )}
      </div>

      {/* repay */}
      <div className="panel">
        <h2>Repay</h2>
        <p className="sub">
          Repay a loan to build good standing. Your wallet pays the USDC back to the lending pool
          (returning cash to lenders and lowering the pool's outstanding), then the repayment is
          recorded on-chain against your loan-book record.
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC){outstanding > 0n ? ` — ${fmtAmount(outstanding)} outstanding` : ""}</span>
            <input type="text" value={repayAmt} onChange={(e) => setRepayAmt(e.target.value)} />
          </label>
          <button className="btn" disabled={!!busy || wrongNetwork} onClick={() => void doRepay()}>
            {busy === "repay" ? "Repaying…" : "Repay"}
          </button>
        </div>
      </div>

      <p className="small muted center">
        Borrowing and repaying are recorded on-chain in the loan-book — and that's exactly what your{" "}
        <strong>Credit Passport</strong> proves over. Cash is drawn from the ZK lending pool (lenders'
        supplied liquidity, provably covered), <strong>never</strong> from customer deposits, so the
        solvency proof backing your account is untouched. This is a testnet prototype.
      </p>
    </>
  );
}
