import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import {
  addressArg,
  isEnforced,
  isWindDown,
  loadVaultState,
  readView,
  type VaultState,
} from "../lib/stellar.ts";
import { addTrustline, connectWallet, invoke } from "../lib/wallet.ts";
import { fundWithFriendbot, usdcReady, usdcStatus, type UsdcStatus } from "../lib/assets.ts";
import { buildSumTree, hex, type Leaf } from "../lib/sumtree.ts";
import {
  getHealth,
  getPassportRoot,
  getPublicBook,
  proveTrigger,
  reconcileBook,
  reconcilePassport,
  type Health,
  type PassportRoot,
  type ProveWorkflow,
  type PublicBook,
} from "../lib/backend.ts";
import {
  CIRCLE_FAUCET_URL,
  contractUrl,
  ISSUER_INITIAL,
  ISSUER_NAME,
  LOANBOOK_ID,
  RESERVE_DECIMALS,
  USDC_CODE,
  USDC_ISSUER,
  txUrl,
} from "../lib/config.ts";
import { bytesToHex, errMsg, fmtAmount, fmtBps, shortHex } from "../lib/format.ts";
import CountUp from "../components/CountUp.tsx";
import Toggle from "../components/Toggle.tsx";
import MarginChart from "../components/MarginChart.tsx";
import UsdcOnboard from "../components/UsdcOnboard.tsx";

function randomBytes(n: number): number[] {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b);
}

// Synthetic customer book for the demo (never leaves the browser).
function genBook(count: number): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < count; i++) {
    const usdc = Math.floor(50 + Math.random() * 4950); // 50..5000 USDC
    out.push({
      account: randomBytes(32),
      balance: BigInt(usdc) * 10n ** BigInt(RESERVE_DECIMALS) + "",
      salt: randomBytes(32),
    });
  }
  return out;
}

// Decoded shape of the loan-book `stats(borrower)` view.
type LoanStats = {
  outstanding: bigint;
  repaid_count: number;
  default_count: number;
  disbursed_count: number;
};

function toStroops(usdc: string): bigint {
  const [w, f = ""] = usdc.trim().split(".");
  const frac = (f + "0".repeat(RESERVE_DECIMALS)).slice(0, RESERVE_DECIMALS);
  return BigInt(w || "0") * 10n ** BigInt(RESERVE_DECIMALS) + BigInt(frac || "0");
}

export default function IssuerDashboard() {
  const [addr, setAddr] = useState<string | null>(null);
  const [state, setState] = useState<VaultState | null>(null);
  const [usdc, setUsdc] = useState<UsdcStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const [count, setCount] = useState(8);
  const [book, setBook] = useState<Leaf[]>([]);
  const [hideWhale, setHideWhale] = useState(false);
  const [root, setRoot] = useState<string>("");
  const [L, setL] = useState<bigint>(0n);

  const [depositAmt, setDepositAmt] = useState("100");
  const [withdrawAmt, setWithdrawAmt] = useState("10");

  // ---- custodian backend + on-chain loan-book (operator control surface) ----
  const [health, setHealth] = useState<Health | null>(null);
  const [pubBook, setPubBook] = useState<PublicBook | null>(null);
  const [passport, setPassport] = useState<PassportRoot | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [borrower, setBorrower] = useState("");
  const [loanAmt, setLoanAmt] = useState("100");
  const [stats, setStats] = useState<LoanStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await loadVaultState());
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  const refreshBackend = useCallback(async () => {
    // Each read degrades independently so a down endpoint never blanks the page.
    const [h, b, p] = await Promise.allSettled([getHealth(), getPublicBook(), getPassportRoot()]);
    setHealth(h.status === "fulfilled" ? h.value : null);
    setPubBook(b.status === "fulfilled" ? b.value : null);
    setPassport(p.status === "fulfilled" ? p.value : null);
  }, []);

  const checkUsdc = useCallback(async (a: string) => {
    try {
      setUsdc(await usdcStatus(a));
    } catch {
      setUsdc(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshBackend();
  }, [refresh, refreshBackend]);

  // The largest customer ("the whale") — highlighted and droppable in the demo.
  const whaleIdx = useMemo(() => {
    if (book.length === 0) return -1;
    return book.reduce(
      (mi, l, i, a) => (BigInt(l.balance) > BigInt(a[mi].balance) ? i : mi),
      0,
    );
  }, [book]);

  // Recompute the liabilities root + L whenever the book / tamper toggle change.
  useEffect(() => {
    let live = true;
    (async () => {
      let effective = book;
      if (hideWhale && book.length > 1 && whaleIdx >= 0) {
        effective = book.filter((_, i) => i !== whaleIdx);
      }
      const { root: r, total } = await buildSumTree(effective);
      if (!live) return;
      setRoot(hex(r));
      setL(total);
    })();
    return () => {
      live = false;
    };
  }, [book, hideWhale, whaleIdx]);

  const generate = () => {
    setBook(genBook(count));
    setHideWhale(false);
  };

  async function connect() {
    setErr(null);
    try {
      const a = await connectWallet();
      setAddr(a);
      void checkUsdc(a);
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  async function doInvoke(
    label: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[],
    contractId?: string,
  ) {
    if (!addr) {
      setErr("connect a wallet first");
      return;
    }
    setBusy(label);
    setErr(null);
    setLastTx(null);
    try {
      const hash = await invoke(addr, method, args, contractId);
      setLastTx(hash);
      await refresh();
      void checkUsdc(addr);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  // ---- custodian backend / loan-book handlers ----
  async function runBackend(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setErr(null);
    setNote(null);
    try {
      setNote(await fn());
      await refreshBackend();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  function doReconcileBook() {
    if (!addr) return void setErr("connect the operator wallet first");
    void runBackend("reconcile", async () => {
      const r = await reconcileBook(addr);
      return `Book reconciled — ${r.count} customers, total L ${fmtAmount(BigInt(r.total || "0"))}, root ${shortHex(r.root, 10, 6)}.`;
    });
  }

  function doReconcilePassport() {
    if (!addr) return void setErr("connect the operator wallet first");
    void runBackend("passport-reconcile", async () => {
      const r = await reconcilePassport(addr);
      return `Passport synced from loan-book — ${r.count} records, anchor ${shortHex(r.root, 10, 6)}.`;
    });
  }

  function doProve(workflow: ProveWorkflow) {
    void runBackend(`prove-${workflow}`, async () => {
      const r = await proveTrigger(workflow);
      if (r.triggered) {
        return `Re-prove (${workflow}) queued on CI — a fresh proof takes ~20 min, then posts on-chain.`;
      }
      return `Not triggered${r.reason ? ` — ${r.reason === "debounced" ? "debounced (a proof ran recently)" : r.reason}` : ""}.`;
    });
  }

  async function lookupStats() {
    if (!borrower.trim()) return void setErr("enter a borrower G-address");
    setBusy("stats");
    setErr(null);
    setStats(null);
    try {
      const raw = (await readView("stats", [addressArg(borrower.trim())], LOANBOOK_ID)) as
        | Record<string, unknown>
        | null;
      if (!raw) throw new Error("no stats returned");
      setStats({
        outstanding: BigInt((raw.outstanding as bigint | number | string) ?? 0),
        repaid_count: Number(raw.repaid_count ?? 0),
        default_count: Number(raw.default_count ?? 0),
        disbursed_count: Number(raw.disbursed_count ?? 0),
      });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  function loanInvoke(label: string, method: string, withAmount: boolean) {
    if (!borrower.trim()) return void setErr("enter a borrower G-address");
    const args = withAmount
      ? [addressArg(borrower.trim()), nativeToScVal(toStroops(loanAmt), { type: "i128" })]
      : [addressArg(borrower.trim())];
    void doInvoke(label, method, args, LOANBOOK_ID);
  }

  // ---- USDC onboarding actions (operator deposits USDC too) ----
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
      await checkUsdc(addr);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  function openFaucet() {
    if (addr) void navigator.clipboard?.writeText(addr).catch(() => {});
    window.open(CIRCLE_FAUCET_URL, "_blank", "noopener,noreferrer");
  }

  const enforced = state ? isEnforced(state.config) : false;
  const windDown = state ? isWindDown(state.status) : false;
  const ratioBps = state?.config.min_ratio_bps ?? 10000;

  // Role of the connected wallet relative to the vault config.
  const isOperator = !!addr && !!state && addr === state.config.operator;
  const isAdmin = !!addr && !!state && addr === state.config.admin;
  const att = state?.attestation ?? null;
  const attAge = state && att ? state.latestLedger - att.ledger : null;

  // Backend provisioning + whether the connected wallet matches its admin signer.
  const backendReady = !!health && health.durableStore && health.operatorConfigured;
  const backendOpMismatch = !!addr && !!health?.operator && addr !== health.operator;

  // Predicted verdict for the current book against live chain numbers.
  const predicted = useMemo(() => {
    if (!state || book.length === 0) return null;
    const reservesOk = state.reserves * 10000n >= BigInt(ratioBps) * L;
    const floorOk = L >= state.netCustodied;
    return { reservesOk, floorOk, solvent: reservesOk && floorOk };
  }, [state, book, L, ratioBps]);

  // Reserve gauge geometry (floor as a fraction of reserves).
  const gauge = useMemo(() => {
    if (!state || state.reserves <= 0n) return { floorPct: 0, marginPct: 0, over: true };
    const floorPct = Math.min(100, Number((state.netCustodied * 10000n) / state.reserves) / 100);
    return { floorPct, marginPct: Math.max(0, 100 - floorPct), over: state.reserves >= state.netCustodied };
  }, [state]);

  return (
    <>
      {/* header */}
      <div className="page-head">
        <div className="issuer-id" style={{ marginBottom: 0 }}>
          <span className="issuer-logo">{ISSUER_INITIAL}</span>
          <span className="issuer-meta">
            <span className="issuer-name">{ISSUER_NAME}</span>
            <br />
            <span className="issuer-kind">operator console · Stellar testnet</span>
          </span>
        </div>
        {addr ? (
          <span className="wallet-chip">
            <span className="wallet-dot" />
            {shortHex(addr, 6, 6)}
            {isAdmin && <span className="role-chip admin">admin</span>}
            {isOperator && <span className="role-chip operator">operator</span>}
            {!isAdmin && !isOperator && <span className="role-chip viewer">view-only</span>}
          </span>
        ) : (
          <button className="btn" onClick={() => void connect()}>Connect wallet</button>
        )}
      </div>

      {err && <div className="error">⚠ {err}</div>}
      {lastTx && (
        <div className="tx-ok">
          ✓ submitted ·{" "}
          <a href={txUrl(lastTx)} target="_blank" rel="noreferrer" className="mono">{shortHex(lastTx, 10, 6)}</a>
        </div>
      )}
      {note && <div className="tx-ok">✓ {note}</div>}

      {addr && !isOperator && !isAdmin && (
        <div className="banner">
          👀 <strong>View-only wallet.</strong> This account isn't the vault's operator or admin, so
          reserve withdrawals and mode changes will revert on-chain. Deposits are open to anyone.
          Connect the operator/admin wallet to manage the vault.
        </div>
      )}

      {/* USDC onboarding (operator funds reserves in USDC) */}
      {addr && usdc && !usdcReady(usdc) && (
        <div className="panel">
          <UsdcOnboard
            usdc={usdc}
            busy={busy}
            onFund={() => void fundXlm()}
            onTrust={() => void addUsdcTrust()}
            onFaucet={openFaucet}
            onRefresh={() => addr && void checkUsdc(addr)}
          />
        </div>
      )}

      {/* reserves */}
      <div className="panel">
        <h2>Reserves</h2>
        <p className="sub">Live on-chain state of the vault.</p>
        {state && (
          <>
            <div className="grid">
              <div className="stat">
                <div className="label">Reserves</div>
                <div className="value">
                  <CountUp to={Number(state.reserves)} render={(n) => fmtAmount(BigInt(Math.round(n)))} />
                </div>
              </div>
              <div className="stat">
                <div className="label">net_custodied (floor)</div>
                <div className="value">
                  <CountUp to={Number(state.netCustodied)} render={(n) => fmtAmount(BigInt(Math.round(n)))} />
                </div>
              </div>
              <div className="stat">
                <div className="label">Margin (reserves − floor)</div>
                <div className="value" style={{ color: gauge.over ? "var(--green)" : "var(--red)" }}>
                  <CountUp to={Number(state.reserves - state.netCustodied)} render={(n) => fmtAmount(BigInt(Math.round(n)))} />
                </div>
              </div>
              <div className="stat">
                <div className="label">Operator withdrawable</div>
                <div className="value">
                  <CountUp to={Number(state.maxOperatorWithdrawable)} render={(n) => fmtAmount(BigInt(Math.round(n)))} />
                </div>
              </div>
              <div className="stat">
                <div className="label">Mode</div>
                <div className="value">
                  <span className={`pill ${enforced ? "green" : "gray"}`}>{enforced ? "ENFORCED" : "ATTEST-ONLY"}</span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Status</div>
                <div className="value">
                  <span className={`pill ${windDown ? "amber" : "green"}`}>{windDown ? "WIND-DOWN" : "HEALTHY"}</span>
                </div>
              </div>
            </div>

            {/* reserve gauge */}
            <div className="gauge mt">
              <div className="gauge-bar">
                <div className="gauge-floor" style={{ width: `${gauge.floorPct}%` }} />
                <div className="gauge-marker" style={{ left: `${gauge.floorPct}%` }} />
              </div>
              <div className="gauge-legend">
                <span><i className="sw floor" /> custodied floor</span>
                <span><i className="sw margin" /> free margin</span>
                <span className="muted">floor is {gauge.floorPct.toFixed(1)}% of reserves</span>
              </div>
            </div>
          </>
        )}

        <div className="op-controls mt">
          <div className="op-control">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Deposit USDC (reserves in)</span>
              <input type="text" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
            </label>
            <button
              className="btn"
              disabled={!!busy || !addr}
              onClick={() =>
                void doInvoke("deposit", "deposit", [
                  new Address(addr!).toScVal(),
                  nativeToScVal(toStroops(depositAmt), { type: "i128" }),
                ])
              }
            >
              {busy === "deposit" ? "…" : "Deposit"}
            </button>
          </div>
          <div className="op-control">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Withdraw USDC (operator out — gated when Enforced)</span>
              <input type="text" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} />
            </label>
            <button
              className="btn danger"
              disabled={!!busy || !addr}
              title={!isOperator && addr ? "requires the operator wallet" : undefined}
              onClick={() =>
                void doInvoke("withdraw", "withdraw_operator", [
                  nativeToScVal(toStroops(withdrawAmt), { type: "i128" }),
                ])
              }
            >
              {busy === "withdraw" ? "…" : "Withdraw"}
            </button>
          </div>
        </div>
        <p className="small muted mt">
          In Enforced mode an over-floor or stale withdrawal <strong>reverts on-chain</strong> — that
          revert is the enforcement (no trusted signer could refuse the operator).
          {!isOperator && addr && " Withdrawals need the operator wallet."}
        </p>
      </div>

      {/* backend status strip */}
      <div className="panel">
        <h2>Custodian backend</h2>
        <p className="sub">
          Live status of the operator service (<code>/api</code>) that holds the private book and
          derives the credit passport. Admin actions below are wallet-signed and only accepted from
          the backend's configured operator address.
        </p>
        {!health ? (
          <div className="banner">
            ⚠ Backend unreachable. It isn't provisioned yet (Redis + <code>OPERATOR_SECRET</code>), so
            the reconcile / prove actions are disabled. The rest of the page still works off-chain.
          </div>
        ) : (
          <>
            <div className="grid">
              <div className="stat">
                <div className="label">Durable store</div>
                <div className="value">
                  <span className={`pill ${health.durableStore ? "green" : "red"}`}>
                    {health.durableStore ? "READY" : "MISSING"}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Operator signer</div>
                <div className="value">
                  <span className={`pill ${health.operatorConfigured ? "green" : "red"}`}>
                    {health.operatorConfigured ? "CONFIGURED" : "UNSET"}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Prover token</div>
                <div className="value">
                  <span className={`pill ${health.proverTokenSet ? "green" : "amber"}`}>
                    {health.proverTokenSet ? "SET" : "UNSET"}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Operator address</div>
                <div className="value mono" style={{ fontSize: 14 }}>
                  {health.operator ? shortHex(health.operator, 6, 6) : "—"}
                </div>
              </div>
            </div>
            {backendOpMismatch && (
              <div className="banner mt">
                ⚠ The connected wallet ({shortHex(addr!, 6, 6)}) is <strong>not</strong> the backend's
                operator ({shortHex(health.operator!, 6, 6)}). Admin actions (reconcile / passport sync)
                will be rejected — connect the operator wallet to run them.
              </div>
            )}
          </>
        )}
      </div>

      {/* custodian book panel */}
      <div className="panel">
        <h2>Custodian book</h2>
        <p className="sub">
          The private per-user ledger the backend proves over. Individual balances stay hidden; only
          the liabilities root and totals below are ever published.
        </p>
        {pubBook ? (
          <div className="grid">
            <div className="stat">
              <div className="label">liabilities_root</div>
              <div className="value mono" style={{ fontSize: 14 }}>{shortHex(pubBook.liabilitiesRoot, 12, 6)}</div>
            </div>
            <div className="stat">
              <div className="label">Total L (liabilities)</div>
              <div className="value">{fmtAmount(BigInt(pubBook.total || "0"))}</div>
            </div>
            <div className="stat">
              <div className="label">Customers</div>
              <div className="value">{pubBook.count.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">Reserves (on-chain)</div>
              <div className="value">{fmtAmount(BigInt(pubBook.reserves || "0"))}</div>
            </div>
            <div className="stat">
              <div className="label">net_custodied (floor)</div>
              <div className="value">{fmtAmount(BigInt(pubBook.netCustodied || "0"))}</div>
            </div>
          </div>
        ) : (
          <div className="banner">The book endpoint is unavailable — backend not provisioned yet.</div>
        )}
        <div className="op-control mt">
          <button
            className="btn"
            disabled={!!busy || !backendReady || !addr}
            title={!backendReady ? "backend not provisioned" : !addr ? "connect the operator wallet" : undefined}
            onClick={doReconcileBook}
          >
            {busy === "reconcile" ? "…" : "Reconcile book"}
          </button>
          <button
            className="btn secondary"
            disabled={!!busy || !health}
            title={!health ? "backend not provisioned" : undefined}
            onClick={() => doProve("solvency")}
          >
            {busy === "prove-solvency" ? "…" : "Re-prove solvency"}
          </button>
        </div>
        <p className="small muted mt">
          <strong>Reconcile</strong> rebuilds the private book from real on-chain custody and re-commits
          the root (admin-signed). <strong>Re-prove</strong> nudges the CI prover — a real RISC Zero
          proof takes ~20 min, then <code>post_attestation</code> lands it on-chain.
        </p>
      </div>

      {/* credit / loan-book panel */}
      <div className="panel">
        <h2>Credit / loan-book</h2>
        <p className="sub">
          Record loan activity on the on-chain loan-book (<code>{shortHex(LOANBOOK_ID, 6, 6)}</code>) — the
          credit-history source the ZK Credit Passport is derived from. Each action is a wallet-signed
          contract call.{" "}
          <a href={contractUrl(LOANBOOK_ID)} target="_blank" rel="noreferrer">view contract ↗</a>
        </p>
        <label className="field">
          <span>Borrower (G-address)</span>
          <input
            type="text"
            value={borrower}
            placeholder="G…"
            onChange={(e) => setBorrower(e.target.value)}
          />
        </label>
        <div className="op-controls">
          <div className="op-control">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Amount (USDC)</span>
              <input type="text" value={loanAmt} onChange={(e) => setLoanAmt(e.target.value)} />
            </label>
            <button
              className="btn"
              disabled={!!busy || !addr}
              onClick={() => loanInvoke("disburse", "disburse", true)}
            >
              {busy === "disburse" ? "…" : "Disburse"}
            </button>
          </div>
          <div className="op-control">
            <button
              className="btn secondary"
              disabled={!!busy || !addr}
              onClick={() => loanInvoke("repay", "repay", true)}
            >
              {busy === "repay" ? "…" : "Repay"}
            </button>
            <button
              className="btn danger"
              disabled={!!busy || !addr}
              onClick={() => loanInvoke("default", "mark_default", false)}
            >
              {busy === "default" ? "…" : "Mark default"}
            </button>
            <button
              className="btn secondary"
              disabled={!!busy || !borrower.trim()}
              onClick={() => void lookupStats()}
            >
              {busy === "stats" ? "…" : "Look up stats"}
            </button>
          </div>
        </div>

        {stats && (
          <div className="grid mt">
            <div className="stat">
              <div className="label">Outstanding</div>
              <div className="value">{fmtAmount(stats.outstanding)}</div>
            </div>
            <div className="stat">
              <div className="label">Repaid</div>
              <div className="value">{stats.repaid_count.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">Defaults</div>
              <div className="value">{stats.default_count.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">Disbursed</div>
              <div className="value">{stats.disbursed_count.toLocaleString()}</div>
            </div>
          </div>
        )}

        <div className="op-control mt">
          <button
            className="btn"
            disabled={!!busy || !backendReady || !addr}
            title={!backendReady ? "backend not provisioned" : !addr ? "connect the operator wallet" : undefined}
            onClick={doReconcilePassport}
          >
            {busy === "passport-reconcile" ? "…" : "Sync passport from loan-book"}
          </button>
          <button
            className="btn secondary"
            disabled={!!busy || !health}
            title={!health ? "backend not provisioned" : undefined}
            onClick={() => doProve("passport")}
          >
            {busy === "prove-passport" ? "…" : "Re-prove passport"}
          </button>
        </div>
        <p className="small muted mt">
          Published credit anchor:{" "}
          {passport ? (
            <>
              <span className="mono">{shortHex(passport.root, 12, 6)}</span> ·{" "}
              {passport.count.toLocaleString()} records
            </>
          ) : (
            <span className="muted">unavailable</span>
          )}
          . <strong>Sync</strong> derives (repaid, defaults) records from the loan-book and re-anchors
          the root (admin-signed); <strong>Re-prove</strong> queues the passport proof on CI (~20 min).
        </p>
      </div>

      {/* solvency proof status */}
      <div className="panel">
        <h2>Solvency proof</h2>
        <p className="sub">The latest attestation posted on-chain, and whether it's still fresh.</p>
        {!att ? (
          <div className="banner">No attestation has been posted yet. Publish one from the proof below.</div>
        ) : (
          <>
            <div className="grid">
              <div className="stat">
                <div className="label">Last verdict</div>
                <div className="value">
                  <span className={`pill ${att.solvent ? "green" : "red"}`}>{att.solvent ? "SOLVENT" : "INSOLVENT"}</span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Freshness</div>
                <div className="value">
                  <span className={`pill ${state?.fresh ? "green" : "amber"}`}>{state?.fresh ? "FRESH" : "STALE"}</span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Proof age</div>
                <div className="value">{attAge != null ? `${attAge.toLocaleString()} ledgers` : "—"}</div>
              </div>
              <div className="stat">
                <div className="label">Staleness window</div>
                <div className="value">{state?.config.max_staleness_ledgers.toLocaleString()} ledgers</div>
              </div>
              <div className="stat">
                <div className="label">Proven ratio</div>
                <div className="value">{fmtBps(att.ratio_bps)}</div>
              </div>
              <div className="stat">
                <div className="label">Min ratio (policy)</div>
                <div className="value">{fmtBps(ratioBps)}</div>
              </div>
            </div>
            <p className="small muted mt">
              Attestation epoch {att.epoch}, ledger {att.ledger.toLocaleString()}. Staleness restricts the{" "}
              <strong>operator only</strong> — user redemptions are never gated.
            </p>
          </>
        )}
      </div>

      {/* margin history (F4) */}
      {state && state.history.length > 0 && (
        <div className="panel">
          <h2>Solvency-margin history</h2>
          <p className="sub">Recent attestations — public lower bound <code>reserves − net_custodied</code>, danger line at zero.</p>
          <MarginChart points={state.history} />
        </div>
      )}

      {/* admin: mode control */}
      <div className="panel">
        <h2>Enforcement mode</h2>
        <p className="sub">
          <strong>Attest-only</strong> records proofs without gating. <strong>Enforced</strong> gates
          operator outflows on a fresh, solvent proof and the on-chain floor. Admin-only.
        </p>
        <div className="op-control">
          <div>
            Currently:{" "}
            <span className={`pill ${enforced ? "green" : "gray"}`}>{enforced ? "ENFORCED" : "ATTEST-ONLY"}</span>
          </div>
          <button
            className="btn"
            disabled={!!busy || !isAdmin}
            title={!isAdmin ? "requires the admin wallet" : undefined}
            onClick={() =>
              void doInvoke("mode", "set_mode", [nativeToScVal(enforced ? 0 : 1, { type: "u32" })])
            }
          >
            {busy === "mode" ? "…" : enforced ? "Switch to Attest-only" : "Switch to Enforced"}
          </button>
        </div>
        {!isAdmin && (
          <p className="small muted mt">
            Connect the <strong>admin</strong> wallet to change the mode. With no fresh proof, flipping to
            Enforced drives <em>operator withdrawable</em> to 0 — that's the enforcement in action.
          </p>
        )}
      </div>

      {/* book -> proof preview */}
      <div className="panel">
        <h2>Book → proof preview</h2>
        <p className="sub">
          Build a private customer book and see exactly what a proof would publish. The book is
          generated and hashed <strong>in your browser</strong>; it never goes on-chain.
        </p>
        <div className="book-toolbar">
          <label className="field" style={{ width: 240, marginBottom: 0 }}>
            <span>Customers: <b style={{ color: "var(--text)" }}>{count}</b></span>
            <input
              type="range"
              min={1}
              max={64}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>
          <button className="btn secondary" onClick={generate}>
            {book.length ? "Regenerate book" : "Generate book"}
          </button>
          {book.length > 1 && (
            <Toggle
              on={hideWhale}
              onChange={setHideWhale}
              danger
              label={<>Hide the whale <span className="muted">(fake solvency)</span></>}
            />
          )}
        </div>

        {book.length > 0 && (
          <>
            <div className="book-viz mt">
              {book.map((l, i) => {
                const hidden = hideWhale && i === whaleIdx && book.length > 1;
                const isWhale = i === whaleIdx;
                return (
                  <div className={`book-row${isWhale ? " whale" : ""}${hidden ? " hidden" : ""}`} key={i}>
                    <span className="book-acct">{shortHex(bytesToHex(l.account), 5, 3)}</span>
                    <span className="book-bal">{fmtAmount(BigInt(l.balance))}</span>
                    {isWhale && <span className="book-tag">🐋 whale</span>}
                    {hidden && <span className="book-tag drop">dropped from proof</span>}
                  </div>
                );
              })}
            </div>

            <div className="split mt">
              <div className="col">
                <h3>Public (goes in the journal)</h3>
                <div className="kv">
                  <span className="k">liabilities_root</span>
                  <span className="v">{shortHex(root, 12, 6)}</span>
                </div>
                <div className="kv">
                  <span className="k">min ratio</span>
                  <span className="v">{fmtBps(ratioBps)}</span>
                </div>
                <div className="kv">
                  <span className="k">next epoch</span>
                  <span className="v">{(state?.epoch ?? 0) + 1}</span>
                </div>
                <div className="kv">
                  <span className="k">verdict</span>
                  <span className="v" style={{ color: predicted ? (predicted.solvent ? "var(--green)" : "var(--red)") : undefined }}>
                    {predicted ? (predicted.solvent ? "SOLVENT" : "INSOLVENT") : "—"}
                  </span>
                </div>
              </div>
              <div className="col">
                <h3>Hidden (never leaves here)</h3>
                <div className="kv">
                  <span className="k">customers proven</span>
                  <span className="v">{hideWhale ? book.length - 1 : book.length}</span>
                </div>
                <div className="kv">
                  <span className="k">total L</span>
                  <span className="v">{fmtAmount(L)}</span>
                </div>
                <div className="kv">
                  <span className="k">individual balances</span>
                  <span className="v">🔒 hidden</span>
                </div>
              </div>
            </div>

            {predicted && (
              <div className={`verdict ${predicted.solvent ? "solvent" : "bad"} mt`}>
                <div className="dot" />
                <div>
                  <div className="big">{predicted.solvent ? "WOULD PROVE SOLVENT" : "WOULD PROVE INSOLVENT"}</div>
                  <div className="note">
                    reserves ≥ ratio·L: {predicted.reservesOk ? "✓" : "✗"} &nbsp;·&nbsp; L ≥
                    net_custodied: {predicted.floorOk ? "✓" : "✗"}
                    {hideWhale &&
                      !predicted.floorOk &&
                      " — hiding the whale drops L below the on-chain custodied floor, so the proof is forced to INSOLVENT."}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="banner mt">
          ⚙️ <strong>Proving is not wired in-browser.</strong> Generating the actual RISC Zero proof
          (STARK → Groth16) runs in the operator's prover service and needs Docker/Bonsai; this panel
          previews the journal the proof would publish. <code>post_attestation</code> submits once a
          real seal is produced. (Labeled WIP per project rules.)
        </div>
      </div>
    </>
  );
}
