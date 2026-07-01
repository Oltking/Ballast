// Loans — the on-ramp that BUILDS your Credit Passport. Borrowing and repaying
// are recorded on-chain in the loan-book contract; that credit history is what
// the ZK Credit Passport proves over. Cash disbursement is drawn from the
// operator's own lending pool (never customer deposits) so solvency is untouched.
import { useCallback, useEffect, useState } from "react";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { addressArg } from "../lib/stellar.ts";
import { invoke } from "../lib/wallet.ts";
import { useWallet } from "../lib/wallet-context.tsx";
import { toStroops } from "../lib/customer.ts";
import {
  borrow as backendBorrow,
  getHealth,
  getLoanStats,
  repay as backendRepay,
  type LoanStats,
} from "../lib/backend.ts";
import { ISSUER_NAME, USDC_SAC, txUrl } from "../lib/config.ts";
import { errMsg, fmtAmount, shortHex } from "../lib/format.ts";

// 100 USDC per-loan cap (mirrors the backend MAX_LOAN).
const LOAN_CAP = 100n;

interface LastTx {
  hash: string;
  label: string;
}

export default function Loans() {
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
  const [operator, setOperator] = useState<string | null>(null);

  const [stats, setStats] = useState<LoanStats | null>(null);
  const [borrowAmt, setBorrowAmt] = useState("25");
  const [repayAmt, setRepayAmt] = useState("25");

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
  }

  // Load standing + operator address once connected.
  useEffect(() => {
    if (!addr) return;
    void refreshStats(addr);
    void getHealth()
      .then((h) => setOperator(h.operator))
      .catch(() => setOperator(null));
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
    try {
      const r = await backendBorrow(addr, stroops.toString());
      setLastTx({ hash: r.loanTx, label: "loan recorded on-chain" });
      if (!r.paid && r.note) setNote(r.note);
      await refreshStats(addr);
    } catch (e) {
      setErr(errMsg(e));
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
    if (!operator) {
      setErr("operator address unavailable — can't route the repayment yet");
      return;
    }
    setBusy("repay");
    setErr(null);
    setNote(null);
    setLastTx(null);
    try {
      // Real repayment: first move the USDC from the borrower to the operator on
      // the SAC, then record the repayment on-chain. If the transfer fails (e.g.
      // no USDC in the wallet), we surface a readable error and record nothing.
      await invoke(
        addr,
        "transfer",
        [addressArg(addr), addressArg(operator), nativeToScVal(stroops.toString(), { type: "i128" })],
        USDC_SAC,
      );
      const r = await backendRepay(addr, stroops.toString());
      setLastTx({ hash: r.tx, label: "repayment recorded on-chain" });
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
          Take a loan of up to {LOAN_CAP.toString()} USDC. The loan is recorded on-chain in the
          loan-book (building your credit); cash is disbursed from the operator's lending pool if it's
          funded.
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC) — up to {LOAN_CAP.toString()}</span>
            <input type="text" value={borrowAmt} onChange={(e) => setBorrowAmt(e.target.value)} />
          </label>
          <button className="btn" disabled={!!busy || wrongNetwork} onClick={() => void doBorrow()}>
            {busy === "borrow" ? "Borrowing…" : "Borrow"}
          </button>
        </div>
      </div>

      {/* repay */}
      <div className="panel">
        <h2>Repay</h2>
        <p className="sub">
          Repay a loan to build good standing. Your wallet transfers the USDC to the operator, then
          the repayment is recorded on-chain against your loan-book record.
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
        <strong>Credit Passport</strong> proves over. Cash disbursement comes from the operator's own
        lending pool, <strong>never</strong> from customer deposits, so the solvency proof backing
        your account is untouched. This is a testnet prototype.
      </p>
    </>
  );
}
