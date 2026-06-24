import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import {
  isEnforced,
  loadVaultState,
  type VaultState,
} from "../lib/stellar.ts";
import { connectWallet, invoke } from "../lib/wallet.ts";
import { buildSumTree, hex, type Leaf } from "../lib/sumtree.ts";
import { RESERVE_DECIMALS, txUrl } from "../lib/config.ts";
import { bytesToHex, fmtAmount, fmtBps, shortHex } from "../lib/format.ts";
import CountUp from "../components/CountUp.tsx";
import Toggle from "../components/Toggle.tsx";

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

function toStroops(usdc: string): bigint {
  const [w, f = ""] = usdc.trim().split(".");
  const frac = (f + "0".repeat(RESERVE_DECIMALS)).slice(0, RESERVE_DECIMALS);
  return BigInt(w || "0") * 10n ** BigInt(RESERVE_DECIMALS) + BigInt(frac || "0");
}

export default function IssuerDashboard() {
  const [addr, setAddr] = useState<string | null>(null);
  const [state, setState] = useState<VaultState | null>(null);
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

  const refresh = useCallback(async () => {
    try {
      setState(await loadVaultState());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      setAddr(await connectWallet());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function doInvoke(label: string, method: string, args: ReturnType<typeof nativeToScVal>[]) {
    if (!addr) {
      setErr("connect a wallet first");
      return;
    }
    setBusy(label);
    setErr(null);
    setLastTx(null);
    try {
      const hash = await invoke(addr, method, args);
      setLastTx(hash);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const enforced = state ? isEnforced(state.config) : false;
  const ratioBps = state?.config.min_ratio_bps ?? 10000;

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
      <div className="panel">
        <div className="page-head">
          <div>
            <h2>Issuer dashboard</h2>
            <p className="sub" style={{ marginBottom: 0 }}>
              Operator console — load book → prove → publish, and manage reserves.
            </p>
          </div>
          {addr ? (
            <span className="wallet-chip">
              <span className="wallet-dot" />
              {shortHex(addr, 6, 6)}
            </span>
          ) : (
            <button className="btn" onClick={() => void connect()}>
              Connect wallet
            </button>
          )}
        </div>
        {err && <div className="error">⚠ {err}</div>}
        {lastTx && (
          <div className="tx-ok">
            ✓ submitted ·{" "}
            <a href={txUrl(lastTx)} target="_blank" rel="noreferrer" className="mono">
              {shortHex(lastTx, 10, 6)}
            </a>
          </div>
        )}
      </div>

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
                  <span className={`pill ${enforced ? "green" : "gray"}`}>
                    {enforced ? "ENFORCED" : "ATTEST-ONLY"}
                  </span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Epoch</div>
                <div className="value">
                  <CountUp to={state.epoch} render={(n) => Math.round(n).toString()} />
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
              <span>Deposit USDC (user funds in)</span>
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
        </p>
      </div>

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
            {/* the private book, visualized */}
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
                  <div className="big">
                    {predicted.solvent ? "WOULD PROVE SOLVENT" : "WOULD PROVE INSOLVENT"}
                  </div>
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
