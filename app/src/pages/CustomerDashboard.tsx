import { useCallback, useEffect, useMemo, useState } from "react";
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  addressArg,
  isWindDown,
  loadVaultState,
  type VaultState,
} from "../lib/stellar.ts";
import { addTrustline, invoke } from "../lib/wallet.ts";
import { useWallet } from "../lib/wallet-context.tsx";
import { fundWithFriendbot, usdcReady, usdcStatus, type UsdcStatus } from "../lib/assets.ts";
import {
  claimLeaf,
  fingerprintAndProof,
  getOrIssueClaim,
  recordEvent,
  saveClaim,
  toStroops,
  type ClaimEvent,
  type StoredClaim,
} from "../lib/customer.ts";
import { fetchAccountEvents, type ChainEvent } from "../lib/events.ts";
import { hexToBytes, verifyInclusion, type InclusionProof } from "../lib/sumtree.ts";
import { backendAvailable, getInclusion, openAccount, withdraw as backendWithdraw } from "../lib/backend.ts";
import {
  CIRCLE_FAUCET_URL,
  ISSUER_NAME,
  SIM_SOURCE,
  USDC_CODE,
  USDC_ISSUER,
  VAULT_ID,
  contractUrl,
  txUrl,
} from "../lib/config.ts";
import { bytesToHex, errMsg, fmtAmount, shortHex } from "../lib/format.ts";
import MerklePath from "../components/MerklePath.tsx";
import CountUp from "../components/CountUp.tsx";
import CopyId from "../components/CopyId.tsx";
import UsdcOnboard from "../components/UsdcOnboard.tsx";

type Counted = "yes" | "no" | null;
// Where the user's leaf comes from: the real operator backend, or the in-browser
// simulation we fall back to before the operator provisions it.
type AccountSource = "backend" | "sim";
// When counted in the backend: is the same leaf already in the ON-CHAIN proven
// attestation root, or only in the live book (folded into the next proof)?
type CountedScope = "attested" | "live" | null;

type ActKind = ClaimEvent["kind"];
interface ActItem {
  kind: ActKind;
  amount?: string;
  ts: number;
  tx?: string;
  onChain: boolean;
}

interface Fp {
  root: string;
  total: bigint;
  proof: InclusionProof;
}

function providerVerdict(v: VaultState | null): { pill: string; cls: string; line: string } {
  if (!v) return { pill: "—", cls: "gray", line: "Loading provider status…" };
  if (isWindDown(v.status))
    return { pill: "WIND-DOWN", cls: "amber", line: "Fair, pro-rata wind-down in progress — users exit proportionally." };
  const att = v.attestation;
  if (!att) return { pill: "NO PROOF YET", cls: "gray", line: `${ISSUER_NAME} hasn't published its first solvency proof.` };
  if (!att.solvent) return { pill: "NOT BACKED", cls: "red", line: "The latest proof did not confirm full backing." };
  if (!v.fresh) return { pill: "DUE A CHECK", cls: "amber", line: "Backed at the last check, but it's past the refresh window. Your withdrawals are unaffected." };
  return { pill: "FULLY BACKED", cls: "green", line: "Reserves cover every customer, proven and fresh on-chain." };
}

export default function CustomerDashboard() {
  // Wallet connection now lives in the shared context — connect once (here or in
  // any other section) and this page sees the account with no re-prompt. Demo
  // mode stays local: it's an in-browser persona, not a real wallet connection.
  const {
    address: walletAddress,
    walletNet,
    wrongNetwork: netMismatch,
    connect: connectWalletCtx,
    disconnect: disconnectWallet,
    refreshNetwork,
  } = useWallet();
  const [isDemo, setIsDemo] = useState(false);
  const addr = isDemo ? SIM_SOURCE : walletAddress;
  const [claim, setClaim] = useState<StoredClaim | null>(null);
  const [fp, setFp] = useState<Fp | null>(null);
  const [vault, setVault] = useState<VaultState | null>(null);

  const [counted, setCounted] = useState<Counted>(null);
  const [countedScope, setCountedScope] = useState<CountedScope>(null);
  const [tamper, setTamper] = useState(false);
  const [revealSalt, setRevealSalt] = useState(false);

  // null while we probe /api/health; then true (real operator backend) or false
  // (not provisioned → simulation). `accountSource` is the mode actually in use
  // for the connected identity (demo always simulates).
  const [backendOn, setBackendOn] = useState<boolean | null>(null);
  const [accountSource, setAccountSource] = useState<AccountSource>("sim");

  const [depositAmt, setDepositAmt] = useState("100");
  const [withdrawAmt, setWithdrawAmt] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const [chain, setChain] = useState<ChainEvent[]>([]);
  const [syncing, setSyncing] = useState(false);

  const [usdc, setUsdc] = useState<UsdcStatus | null>(null);
  const [waitingForUsdc, setWaitingForUsdc] = useState(false);

  // Check whether this wallet is XLM-funded, holds a USDC trustline, and its
  // balance — so we can guide the user to claim test USDC before depositing.
  const checkUsdc = useCallback(async (a: string) => {
    try {
      setUsdc(await usdcStatus(a));
    } catch {
      setUsdc(null);
    }
  }, []);

  // Pull this account's real on-chain deposit/withdraw history from the event
  // index — ledger truth, not our local record. Degrades to empty gracefully.
  const syncChain = useCallback(async (a: string) => {
    setSyncing(true);
    try {
      setChain(await fetchAccountEvents(a));
    } catch {
      setChain([]);
    } finally {
      setSyncing(false);
    }
  }, []);

  const refreshVault = useCallback(async () => {
    try {
      setVault(await loadVaultState());
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);

  // Recompute the simulated fingerprint + inclusion proof whenever the claim
  // changes. In backend mode the proof comes from the operator (fetched on
  // "Am I counted?"), so this only resets the local verdict — it never builds a
  // fake book over the real leaf.
  const recompute = useCallback(
    async (c: StoredClaim) => {
      setTamper(false);
      setCounted(null);
      setCountedScope(null);
      if (accountSource === "backend") return;
      setFp(await fingerprintAndProof(c));
    },
    [accountSource],
  );

  // Probe the operator backend once on mount (cached for the session).
  useEffect(() => {
    void backendAvailable()
      .then(setBackendOn)
      .catch(() => setBackendOn(false));
  }, []);

  // Side data for the connected identity: provider solvency, on-chain activity,
  // and (for real wallets) USDC onboarding status.
  useEffect(() => {
    if (!addr) return;
    void refreshVault();
    void syncChain(addr);
    if (!isDemo) void checkUsdc(addr);
  }, [addr, isDemo, refreshVault, syncChain, checkUsdc]);

  // Acquire the user's leaf once the backend probe has resolved. Real wallet +
  // backend provisioned → open the real account (one wallet signature). Demo, or
  // backend unavailable / sign rejected → in-browser simulation.
  useEffect(() => {
    if (!addr || backendOn === null) return;
    let cancelled = false;
    void (async () => {
      if (!isDemo && backendOn) {
        try {
          const leaf = await openAccount(addr);
          if (cancelled) return;
          setAccountSource("backend");
          setClaim({
            address: addr,
            salt: Array.from(hexToBytes(leaf.salt)),
            balance: leaf.balance,
            createdAt: Date.now(),
            events: [],
          });
          setFp(null);
          setCounted(null);
          setCountedScope(null);
          setTamper(false);
          return;
        } catch (e) {
          if (cancelled) return;
          setErr(errMsg(e));
          // fall through to the simulation so the page still works
        }
      }
      const c = getOrIssueClaim(addr);
      if (cancelled) return;
      setAccountSource("sim");
      setClaim(c);
      setCounted(null);
      setCountedScope(null);
      setTamper(false);
      setFp(await fingerprintAndProof(c));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addr, isDemo, backendOn]);

  // After sending the user to the external faucet, auto-resume the flow: poll
  // for the USDC and re-check whenever they return to this tab, so the moment
  // it lands the onboarding advances on its own — no manual refresh needed.
  useEffect(() => {
    if (!waitingForUsdc || !addr || isDemo) return;
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
  }, [waitingForUsdc, addr, isDemo, usdc, checkUsdc]);

  // Reconcile the shown balance with real on-chain deposit/withdrawal events, so
  // the dashboard self-heals if a local optimistic update was ever lost (e.g. an
  // old result-decode error fired *after* a deposit already settled on-chain).
  useEffect(() => {
    if (isDemo || !claim || chain.length === 0) return;
    let net = 0n;
    for (const e of chain) {
      net += e.kind === "deposit" ? BigInt(e.amount || "0") : -BigInt(e.amount || "0");
    }
    if (net < 0n) net = 0n;
    if (net.toString() !== claim.balance) {
      const next: StoredClaim = { ...claim, balance: net.toString() };
      setClaim(next);
      saveClaim(next);
      void recompute(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, isDemo]);

  function beginDemo() {
    setErr(null);
    setIsDemo(true);
  }

  async function connect() {
    setErr(null);
    setIsDemo(false);
    await connectWalletCtx();
  }

  // Re-read the wallet's network (after the user switches it to Testnet).
  async function recheckNetwork() {
    await refreshNetwork();
    if (addr) void checkUsdc(addr);
  }

  function disconnect() {
    disconnectWallet();
    setClaim(null);
    setFp(null);
    setCounted(null);
    setCountedScope(null);
    setAccountSource("sim");
    setLastTx(null);
    setIsDemo(false);
    setChain([]);
    setUsdc(null);
    setWaitingForUsdc(false);
  }

  const operator = vault?.config.operator ?? null;
  const isOperator = !!addr && !!operator && addr === operator;

  // ---- actions ----

  async function fundXlm() {
    if (!addr || isDemo) return;
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
    if (!addr || isDemo) return;
    setBusy("trust");
    setErr(null);
    setLastTx(null);
    try {
      const tx = await addTrustline(addr, USDC_CODE, USDC_ISSUER);
      setLastTx(tx);
      // Horizon can lag a beat behind the ledger; poll until the new trustline
      // shows up so the step reliably advances instead of looking stuck.
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

  async function deposit() {
    if (!addr || !claim || isDemo) return;
    const stroops = toStroops(depositAmt);
    if (stroops <= 0n) {
      setErr("enter a positive amount");
      return;
    }
    setBusy("deposit");
    setErr(null);
    setLastTx(null);
    try {
      const tx = await invoke(addr, "deposit", [
        addressArg(addr),
        nativeToScVal(stroops, { type: "i128" }),
      ]);
      setLastTx(tx);
      // The operator credits your private-book leaf (simulated here) to match.
      const next = recordEvent(
        { ...claim, balance: (BigInt(claim.balance) + stroops).toString() },
        { kind: "deposit", amount: stroops.toString(), ts: Date.now(), tx },
      );
      setClaim(next);
      await recompute(next);
      await refreshVault();
      void checkUsdc(addr);
      // The event index lags settlement by a ledger or two — reconcile shortly.
      setTimeout(() => void syncChain(addr), 6000);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  async function requestWithdraw() {
    if (!addr || !claim) return;
    const stroops = toStroops(withdrawAmt);
    if (stroops <= 0n) {
      setErr("enter a positive amount");
      return;
    }
    if (stroops > BigInt(claim.balance)) {
      setErr("amount exceeds your claim");
      return;
    }
    setErr(null);

    // Real operator backend: you authorize with a wallet signature and the
    // operator fulfils `withdraw_user(to=you, amount)` on-chain, paying your
    // address. The returned balance is authoritative (debited server-side).
    if (accountSource === "backend" && !isDemo) {
      setBusy("withdraw");
      setLastTx(null);
      try {
        const r = await backendWithdraw(addr, stroops.toString());
        setLastTx(r.txHash);
        const next = recordEvent(
          { ...claim, balance: r.balance },
          { kind: "withdraw", amount: stroops.toString(), ts: Date.now(), tx: r.txHash },
        );
        setClaim(next);
        await refreshVault();
        setTimeout(() => void syncChain(addr), 6000);
      } catch (e) {
        setErr(errMsg(e));
      } finally {
        setBusy(null);
      }
      return;
    }

    // Redemptions are operator-orchestrated on-chain. If the connected wallet IS
    // the operator (demo persona), execute it for real; otherwise record the
    // request the operator would fulfil against its private book.
    if (isOperator && !isDemo) {
      setBusy("withdraw");
      setLastTx(null);
      try {
        const tx = await invoke(addr, "withdraw_user", [
          addressArg(addr),
          nativeToScVal(stroops, { type: "i128" }),
        ]);
        setLastTx(tx);
        const next = recordEvent(
          { ...claim, balance: (BigInt(claim.balance) - stroops).toString() },
          { kind: "withdraw", amount: stroops.toString(), ts: Date.now(), tx },
        );
        setClaim(next);
        await recompute(next);
        await refreshVault();
        setTimeout(() => void syncChain(addr), 6000);
      } catch (e) {
        setErr(errMsg(e));
      } finally {
        setBusy(null);
      }
      return;
    }

    const next = recordEvent(claim, {
      kind: "withdraw-request",
      amount: stroops.toString(),
      ts: Date.now(),
    });
    setClaim(next);
  }

  // bump the balance by 1 stroop — the tampered leaf no longer folds to root
  function tamperProof(proof: InclusionProof): InclusionProof {
    return {
      ...proof,
      leaf: { ...proof.leaf, balance: (BigInt(proof.leaf.balance) + 1n).toString() },
    };
  }

  async function checkCounted() {
    if (!addr || !claim) return;
    setBusy("counted");
    setErr(null);
    try {
      if (accountSource === "backend") {
        // Fetch the operator's inclusion proof for YOUR leaf, then verify it
        // LOCALLY against both the live backend root and the on-chain proven
        // attestation root — so the verdict is checked, not just asserted.
        const incl = await getInclusion(addr);
        if (!incl) {
          setFp(null);
          setCounted("no");
          setCountedScope(null);
          return;
        }
        setFp({ root: incl.root, total: 0n, proof: incl.proof });
        const proof = tamper ? tamperProof(incl.proof) : incl.proof;
        const okBackend = await verifyInclusion(proof, hexToBytes(incl.root));
        const attRoot = vault?.attestation?.liabilities_root ?? null;
        const okOnChain = attRoot ? await verifyInclusion(proof, attRoot) : false;
        setCounted(okBackend ? "yes" : "no");
        setCountedScope(okBackend ? (okOnChain ? "attested" : "live") : null);
        return;
      }

      // Simulation: fold the locally-issued claim into the local fingerprint.
      if (!fp) return;
      const proof = tamper ? tamperProof(fp.proof) : fp.proof;
      const ok = await verifyInclusion(proof, hexToBytes(fp.root));
      setCounted(ok ? "yes" : "no");
      setCountedScope(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  function downloadClaim() {
    if (!claim || !fp) return;
    const ticket = {
      issuer: ISSUER_NAME,
      address: claim.address,
      leaf: claimLeaf(claim),
      proof: fp.proof,
      liabilities_root: fp.root,
      note: "Your private claim ticket. Keep the salt secret — it blinds your balance in the public fingerprint. This is NOT a wallet key.",
    };
    const blob = new Blob([JSON.stringify(ticket, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ballast-claim-${shortHex(bytesToHex(claimLeaf(claim).account), 6, 0)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function resetClaim() {
    if (!addr) return;
    const fresh: StoredClaim = {
      address: addr,
      salt: claim?.salt ?? [],
      balance: "0",
      createdAt: Date.now(),
      events: [{ kind: "issued", ts: Date.now() }],
    };
    saveClaim(fresh);
    setClaim(fresh);
    void recompute(fresh);
  }

  const pv = providerVerdict(vault);
  // The wallet is pointed at a different network than this testnet app — every
  // tx it signs will be rejected by testnet Horizon until the user switches.
  const wrongNetwork = !isDemo && netMismatch;
  const walletNetName = walletNet.startsWith("Public") ? "Mainnet (Public)" : walletNet ? "a non-testnet network" : "";
  const balance = claim ? BigInt(claim.balance) : 0n;
  const acctHex = useMemo(() => (claim ? bytesToHex(claimLeaf(claim).account) : ""), [claim]);
  const saltHex = useMemo(() => (claim ? bytesToHex(claim.salt) : ""), [claim]);

  // Merge the real on-chain history (authoritative) with local-only entries
  // (issued, pending requests, not-yet-indexed deposits). Chain wins on tx.
  const activity = useMemo<ActItem[]>(() => {
    const chainTxs = new Set(chain.map((e) => e.tx));
    const items: ActItem[] = chain.map((e) => ({
      kind: e.kind,
      amount: e.amount,
      ts: e.ts,
      tx: e.tx,
      onChain: true,
    }));
    for (const ev of claim?.events ?? []) {
      if (ev.tx && chainTxs.has(ev.tx)) continue; // confirmed on-chain already
      items.push({ kind: ev.kind, amount: ev.amount, ts: ev.ts, tx: ev.tx, onChain: false });
    }
    return items.sort((a, b) => b.ts - a.ts);
  }, [chain, claim]);

  // ---- not connected ----
  if (!addr) {
    return (
      <>
        <div className="issuer-id">
          <span className="issuer-logo">H</span>
          <span className="issuer-meta">
            <span className="issuer-name">{ISSUER_NAME}</span>
            <br />
            <span className="issuer-kind">your account · Stellar testnet</span>
          </span>
        </div>

        <div className="trust-hero tone-idle">
          <div className="seal">
            <div className="seal-ring" />
            <div className="seal-core" aria-hidden="true">⛵</div>
          </div>
          <h1 className="trust-headline">Your money, your proof.</h1>
          <p className="trust-sub">
            Connect your Stellar wallet to deposit, hold your private claim ticket, and verify for
            yourself that {ISSUER_NAME} counts you and can cover you — without anyone seeing your
            balance.
          </p>
          {err && <div className="error mt">⚠ {err}</div>}
          <div className="trust-cta">
            <button className="btn primary" onClick={() => void connect()}>Connect wallet</button>
            <button className="btn secondary" onClick={beginDemo}>Explore with a demo identity</button>
          </div>
          <div className="trust-facts">
            <span className="trust-fact"><span className="ic" aria-hidden="true">🔑</span> Your wallet is your identity</span>
            <span className="trust-fact"><span className="ic" aria-hidden="true">🔒</span> Your balance never goes public</span>
            <span className="trust-fact"><span className="ic" aria-hidden="true">⛓</span> Deposits settle on Stellar</span>
          </div>
        </div>

        <div className="promise">
          <div className="promise-card"><div className="promise-ic" aria-hidden="true">💵</div><h3>Deposit</h3><p>Move USDC into the custodian's on-chain vault — you authorize it yourself, no middle-man holds your key.</p></div>
          <div className="promise-card"><div className="promise-ic" aria-hidden="true">🎫</div><h3>Hold your claim</h3><p>Your provider issues you a private claim ticket. It's how you prove you're counted — your balance stays blinded.</p></div>
          <div className="promise-card"><div className="promise-ic" aria-hidden="true">✓</div><h3>Verify anytime</h3><p>Fold your claim into the public fingerprint to confirm you're in the books, and check reserves cover everyone.</p></div>
        </div>
      </>
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
            <span className="issuer-kind">your account{isDemo ? " · demo identity" : ""}</span>
          </span>
        </div>
        <span className="wallet-chip">
          <span className="wallet-dot" />
          {shortHex(addr, 6, 6)}
          <button className="linklike" onClick={disconnect}>change</button>
        </span>
      </div>

      {isDemo && (
        <div className="banner">
          🧪 <strong>Demo identity.</strong> You're exploring as a sample customer (read-only). Connect
          a real wallet to deposit and request withdrawals on testnet.
        </div>
      )}
      {!isDemo && backendOn !== null && accountSource === "sim" && (
        <div className="banner">
          🧪{" "}
          {backendOn ? (
            <>
              <strong>Local simulation.</strong> Couldn't open your operator account — showing an
              in-browser simulation of your private book for now.
            </>
          ) : (
            <>
              <strong>Operator backend not provisioned.</strong> Showing a local simulation of your
              account — deposits and provider solvency are still real on-chain.
            </>
          )}
        </div>
      )}
      {wrongNetwork && (
        <div className="net-warn">
          <div className="net-warn-title">⚠ Your wallet is on {walletNetName} — switch it to <strong>Testnet</strong></div>
          <p>
            This app runs entirely on the Stellar <strong>test</strong> network (play money, no real
            funds). Your wallet is currently on {walletNetName}, so it shows 0 XLM and every action
            here gets rejected. In your wallet, change the network to <strong>Testnet</strong>, then:
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

      {/* personal status strip */}
      <div className="acct-strip">
        <div className="acct-stat">
          <div className="label">Your balance</div>
          <div className="value big-num">
            <CountUp to={Number(balance)} render={(n) => "$" + fmtAmount(BigInt(Math.round(n)))} />
          </div>
        </div>
        <div className="acct-stat">
          <div className="label">Counted in the books</div>
          <div className="value">
            {counted === "yes" ? <span className="pill green">YES ✓</span>
              : counted === "no" ? <span className="pill red">NO ✗</span>
              : <span className="pill gray">check below</span>}
          </div>
        </div>
        <div className="acct-stat">
          <div className="label">Provider solvency</div>
          <div className="value"><span className={`pill ${pv.cls}`}>{pv.pill}</span></div>
        </div>
      </div>

      {/* get testnet USDC — onboarding helper */}
      {!isDemo && !wrongNetwork && usdc && !usdcReady(usdc) && balance === 0n && (
        <div className="panel">
          <UsdcOnboard
            usdc={usdc}
            busy={busy}
            waiting={waitingForUsdc}
            onFund={() => void fundXlm()}
            onTrust={() => void addUsdcTrust()}
            onFaucet={openFaucet}
            onRefresh={() => addr && void checkUsdc(addr)}
          />
        </div>
      )}

      {/* deposit */}
      <div className="panel">
        <h2>Deposit</h2>
        <p className="sub">
          Move USDC into {ISSUER_NAME}'s on-chain vault. You authorize this yourself — the custodian
          never holds your key. It settles on Stellar and raises the on-chain custodied floor.
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC)</span>
            <input type="text" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} disabled={isDemo} />
          </label>
          <button className="btn" disabled={!!busy || isDemo || wrongNetwork} onClick={() => void deposit()}>
            {busy === "deposit" ? "Depositing…" : "Deposit"}
          </button>
        </div>
        {!isDemo && usdc && (
          <p className="small muted mt">
            You have <strong>{usdc.balance} USDC</strong> in your wallet
            {Number(usdc.balance) > 0 ? (
              <>
                {" · "}
                <button className="linklike" onClick={() => setDepositAmt(usdc.balance.replace(/\.?0+$/, ""))}>
                  deposit max
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
            .
          </p>
        )}
        <p className="small muted mt">
          {accountSource === "backend" ? (
            <>
              Your provider's private book reconciles this deposit from on-chain custody and re-commits
              its liabilities root — so your claim stays in the proof.
            </>
          ) : (
            <>
              Your provider then records this in its private ledger and re-issues your claim. <em>Here
              that bookkeeping step is simulated in your browser</em> so you can see the whole lifecycle.
            </>
          )}
        </p>
      </div>

      {/* claim ticket */}
      <div className="panel">
        <h2>Your claim ticket</h2>
        <p className="sub">
          This is what proves you're counted — the leaf {ISSUER_NAME} commits to the public fingerprint.
          Your <strong>salt</strong> is a private blinding factor that hides your balance in that
          fingerprint. It is <strong>not</strong> a wallet key and gives no one access to your funds.
        </p>
        <div className="ticket">
          <div className="ticket-row">
            <span className="k">account (your address)</span>
            <span className="v"><CopyId value={acctHex} /></span>
          </div>
          <div className="ticket-row">
            <span className="k">balance (your claim)</span>
            <span className="v strong">{fmtAmount(balance)} USDC</span>
          </div>
          <div className="ticket-row">
            <span className="k">salt (secret blinding)</span>
            <span className="v">
              {revealSalt ? <CopyId value={saltHex} /> : <span className="mono muted">{"•".repeat(24)}</span>}
              <button className="linklike" onClick={() => setRevealSalt((s) => !s)}>{revealSalt ? "hide" : "reveal"}</button>
            </span>
          </div>
        </div>
        <div className="row mt">
          <button className="btn secondary" onClick={downloadClaim} disabled={!fp}>⤓ Download claim ticket</button>
          {accountSource === "sim" && (
            <button className="btn secondary" onClick={resetClaim}>Reset claim</button>
          )}
        </div>
      </div>

      {/* verify */}
      <div className="panel">
        <h2>Am I counted?</h2>
        <p className="sub">
          {accountSource === "backend"
            ? "The operator hands you the inclusion proof for your own leaf; your browser folds it up the tree to confirm it reproduces the published fingerprint — and checks it against the on-chain proven root. Nobody else's balance is revealed."
            : "Fold your claim up the tree and check it reproduces the public fingerprint — the same SHA-256 sum-tree the zero-knowledge proof uses. Nobody else's balance is revealed."}
        </p>

        {counted === "yes" && (
          <div className="verdict solvent">
            <div className="dot" />
            <div>
              <div className="big">
                {countedScope === "attested"
                  ? "✓ Counted in the on-chain proof"
                  : countedScope === "live"
                    ? "✓ Counted in the live book"
                    : "✓ You're counted"}
              </div>
              <div className="note">
                Your {fmtAmount(balance)} claim folds to the fingerprint
                <span className="mono"> {fp ? shortHex(fp.root, 8, 6) : ""}</span>.{" "}
                {countedScope === "attested"
                  ? "That root matches the attestation proven on-chain — you are inside the latest solvency proof. The custodian can't drop you without changing a fingerprint everyone can see."
                  : countedScope === "live"
                    ? "This is the operator's live book; it differs from the last on-chain proof, so you'll be folded into the next attestation. The custodian can't drop you without changing a fingerprint everyone can see."
                    : "The custodian can't drop you without changing the fingerprint everyone can see."}
              </div>
            </div>
          </div>
        )}
        {counted === "no" && (
          <div className="verdict bad">
            <div className="dot" />
            <div>
              <div className="big">✗ Not counted</div>
              <div className="note">
                {tamper
                  ? "With the balance tampered (+1 stroop), the leaf no longer folds to the fingerprint — exactly the guarantee at work."
                  : "This claim doesn't fold to the fingerprint."}
              </div>
            </div>
          </div>
        )}

        <div className="row check-actions" style={{ justifyContent: "flex-start" }}>
          <button
            className="btn primary"
            onClick={() => void checkCounted()}
            disabled={!!busy || !claim || (accountSource === "sim" && !fp)}
          >
            {busy === "counted" ? "Folding…" : "Check inclusion"}
          </button>
          <label className="inline-check">
            <input type="checkbox" checked={tamper} onChange={(e) => { setTamper(e.target.checked); setCounted(null); setCountedScope(null); }} />
            simulate tampering
          </label>
        </div>

        {fp && (
          <div className="check-viz">
            <MerklePath proof={fp.proof} ok={counted === "yes" ? true : counted === "no" ? false : undefined} />
          </div>
        )}
      </div>

      {/* provider solvency */}
      <div className="panel">
        <h2>Can they cover me?</h2>
        <p className="sub">{pv.line}</p>
        <div className="grid">
          <div className="stat">
            <div className="label">On-chain reserves</div>
            <div className="value">{vault ? fmtAmount(vault.reserves) : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Custodied floor</div>
            <div className="value">{vault ? fmtAmount(vault.netCustodied) : "—"}</div>
          </div>
          <div className="stat">
            <div className="label">Status</div>
            <div className="value"><span className={`pill ${pv.cls}`}>{pv.pill}</span></div>
          </div>
        </div>
        <p className="small muted mt">
          Provider solvency is read live from the vault contract — no server in the middle. Your
          right to withdraw is <strong>never</strong> gated by it.
        </p>
      </div>

      {/* activity */}
      <div className="panel">
        <h2>
          Your activity
          {syncing && <span className="sync-tag"> · syncing chain…</span>}
        </h2>
        <p className="sub">
          Deposits and withdrawals are read straight from the Stellar event index, so the timestamp
          is the real ledger close time. <span className="on-chain-badge">on-chain</span> entries are
          confirmed on the ledger; others are pending or local to this session.
        </p>
        <ul className="activity">
          {activity.map((ev, i) => (
            <li key={ev.tx ?? `local-${i}`} className={`act act-${ev.kind}`}>
              <span className="act-ic" aria-hidden="true">{actIcon(ev)}</span>
              <span className="act-body">
                <span className="act-title">
                  {actTitle(ev)}
                  {ev.onChain && <span className="on-chain-badge">on-chain</span>}
                </span>
                <span className="act-meta">
                  {new Date(ev.ts).toLocaleString()}
                  {ev.tx && (
                    <>
                      {" · "}
                      <a href={txUrl(ev.tx)} target="_blank" rel="noreferrer" className="mono">{shortHex(ev.tx, 6, 4)}</a>
                    </>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <p className="small muted">
          <a href={contractUrl(VAULT_ID)} target="_blank" rel="noreferrer">View the full vault history on stellar.expert ↗</a>
        </p>
      </div>

      {/* withdraw */}
      <div className="panel">
        <h2>Withdraw</h2>
        <p className="sub">
          {accountSource === "backend"
            ? "You authorize the redemption with a wallet signature; the operator fulfils it on-chain and pays your address against its private book. Your right to exit is never gated by solvency or staleness."
            : isOperator
              ? "You're connected as the operator — redemptions execute on-chain directly."
              : "Redemptions are operator-orchestrated: you request, and the custodian pays you out against its private book. Your right to exit is never gated by solvency or staleness."}
        </p>
        <div className="op-control">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Amount (USDC) — up to your {fmtAmount(balance)} claim</span>
            <input type="text" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} />
          </label>
          <button className="btn" disabled={!!busy} onClick={() => void requestWithdraw()}>
            {busy === "withdraw"
              ? "Withdrawing…"
              : accountSource === "backend" || isOperator
                ? "Withdraw"
                : "Request withdrawal"}
          </button>
        </div>
        {!isOperator && (
          <p className="small muted mt">
            In wind-down, payouts are pro-rated (<span className="mono">amount · reserves / floor</span>)
            so there's no first-come advantage — everyone recovers the same ratio.
          </p>
        )}
      </div>

      <p className="small muted center">
        {accountSource === "backend" ? (
          <>
            Your inclusion check runs entirely in your browser — the same <code>ballast-core</code>{" "}
            sum-tree as the RISC Zero guest — so the operator's proof and the on-chain root can never
            drift.
          </>
        ) : (
          <>
            The leaf, salt and inclusion check run entirely in your browser — the same{" "}
            <code>ballast-core</code> sum-tree as the RISC Zero guest, so they can never drift.
          </>
        )}
      </p>
    </>
  );
}

function actIcon(ev: { kind: ActKind }): string {
  switch (ev.kind) {
    case "deposit": return "↓";
    case "withdraw": return "↑";
    case "withdraw-request": return "⏳";
    default: return "🎫";
  }
}
function actTitle(ev: { kind: ActKind; amount?: string }): string {
  const amt = ev.amount ? fmtAmount(BigInt(ev.amount)) + " USDC" : "";
  switch (ev.kind) {
    case "deposit": return `Deposited ${amt}`;
    case "withdraw": return `Withdrew ${amt}`;
    case "withdraw-request": return `Requested withdrawal of ${amt}`;
    default: return "Claim ticket issued";
  }
}
