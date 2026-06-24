import { useCallback, useEffect, useState } from "react";
import {
  isEnforced,
  isWindDown,
  loadVaultState,
  type VaultState,
} from "../lib/stellar.ts";
import {
  VAULT_ID,
  contractUrl,
  ISSUER_NAME,
  ISSUER_KIND,
  ISSUER_INITIAL,
} from "../lib/config.ts";
import { bytesToHex, errMsg, fmtAmount, fmtBps, shortId } from "../lib/format.ts";
import MarginChart from "../components/MarginChart.tsx";
import PartnerGate from "../components/PartnerGate.tsx";
import CountUp from "../components/CountUp.tsx";
import CopyId from "../components/CopyId.tsx";

type Tone = "safe" | "warn" | "risk" | "idle";

interface Consumer {
  tone: Tone;
  seal: string;
  headline: React.ReactNode;
  sub: React.ReactNode;
  fillPct: number;
  backedLead: string;
  backedRight: string;
}

function agoText(ledgersSince: number | null): string {
  if (ledgersSince == null) return "—";
  const secs = ledgersSince * 5; // ~5s per testnet ledger
  if (secs < 90) return "moments ago";
  if (secs < 3600) return `about ${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `about ${Math.round(secs / 3600)} h ago`;
  return `about ${Math.round(secs / 86400)} d ago`;
}

function consumerOf(s: VaultState, ledgersSince: number | null): Consumer {
  const att = s.attestation;
  if (isWindDown(s.status)) {
    return {
      tone: "warn",
      seal: "⚖",
      headline: <>A <span className="accent-warn">fair wind-down</span> is in progress.</>,
      sub: (
        <>
          Withdrawals are being paid out <strong>proportionally to everyone</strong> — no first-come
          advantage, no bank run. Your share is protected.
        </>
      ),
      fillPct: 100,
      backedLead: "Protected wind-down",
      backedRight: "everyone paid fairly",
    };
  }
  if (!att) {
    return {
      tone: "idle",
      seal: "•",
      headline: <>Not checked yet.</>,
      sub: (
        <>
          {ISSUER_NAME} hasn't published its first solvency proof. There's nothing claimed here yet —
          and nothing to take on trust.
        </>
      ),
      fillPct: 0,
      backedLead: "Awaiting first proof",
      backedRight: "—",
    };
  }
  if (!att.solvent) {
    return {
      tone: "risk",
      seal: "!",
      headline: <>Warning: <span className="accent-risk">not fully backed.</span></>,
      sub: (
        <>
          The latest check did <strong>not</strong> confirm that reserves cover every customer. The
          blockchain rejected the claim — treat this custodian with caution.
        </>
      ),
      fillPct: 55,
      backedLead: "Backing not confirmed",
      backedRight: "proof failed",
    };
  }
  if (!s.fresh) {
    return {
      tone: "warn",
      seal: "↻",
      headline: <>Backed — but <span className="accent-warn">due for a fresh check.</span></>,
      sub: (
        <>
          The last proof confirmed full backing, but it's older than the refresh window. <strong>Your
          withdrawals are unaffected</strong>; the operator just can't move funds out until a new
          proof is posted.
        </>
      ),
      fillPct: 100,
      backedLead: "Last check passed",
      backedRight: `checked ${agoText(ledgersSince)}`,
    };
  }
  return {
    tone: "safe",
    seal: "✓",
    headline: <>Your money is <span className="accent-safe">fully backed.</span></>,
    sub: (
      <>
        Every dollar {ISSUER_NAME} owes its customers is matched by real reserves held on-chain —
        <strong> proven by math, checked live</strong>, not just promised.
      </>
    ),
    fillPct: 100,
    backedLead: "100% backed",
    backedRight: `verified ${agoText(ledgersSince)}`,
  };
}

export default function PublicVerifier() {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [techOpen, setTechOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await loadVaultState());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ledgersSince =
    state?.attestation != null ? state.latestLedger - state.attestation.ledger : null;
  const v = state ? consumerOf(state, ledgersSince) : null;
  const enforced = state ? isEnforced(state.config) : false;
  const initialLoading = !state && loading;

  return (
    <>
      {/* who we're checking */}
      <div className="issuer-id">
        <span className="issuer-logo">{ISSUER_INITIAL}</span>
        <span className="issuer-meta">
          <span className="issuer-name">{ISSUER_NAME}</span>
          <br />
          <span className="issuer-kind">{ISSUER_KIND}</span>
        </span>
      </div>

      {/* hero verdict */}
      <div className={`trust-hero tone-${v?.tone ?? "idle"}`} aria-busy={initialLoading}>
        <div className="seal">
          <div className="seal-ring" />
          <div
            className={`seal-core ${initialLoading ? "seal-wait" : "seal-pop"}`}
            key={initialLoading ? "wait" : v?.tone}
            aria-hidden="true"
          >
            {initialLoading ? "" : v?.seal ?? "•"}
          </div>
        </div>

        {initialLoading ? (
          <>
            <div className="sk-line sk-lg" />
            <div className="sk-line sk-md" />
            <span className="sk-caption">Reading the latest proof from Stellar…</span>
          </>
        ) : v ? (
          <>
            <h1 className="trust-headline">{v.headline}</h1>
            <p className="trust-sub">{v.sub}</p>
          </>
        ) : (
          <>
            <h1 className="trust-headline">We couldn't reach the network.</h1>
            <p className="trust-sub">
              Your funds aren't affected — this page just can't load the latest proof right now.
              Give it a moment and try again.
            </p>
          </>
        )}

        {error && !initialLoading && (
          <div className="error mt">⚠ Couldn't reach the network: {error}</div>
        )}

        {v && (
          <div className="backed">
            <div className="backed-track">
              <div className="backed-fill" style={{ width: `${v.fillPct}%` }} />
            </div>
            <div className="backed-meta">
              <span className="lead">{v.backedLead}</span>
              <span className="right">{v.backedRight}</span>
            </div>
          </div>
        )}

        <div className="trust-cta">
          <a className="btn primary" href="#how">How does this work?</a>
          <button className="btn secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "Re-checking…" : "↻ Re-check now"}
          </button>
        </div>

        {state && (
          <div className="trust-facts">
            <span className="trust-fact"><span className="ic" aria-hidden="true">🔒</span> No customer data revealed</span>
            <span className="trust-fact">
              <span className="ic" aria-hidden="true">🏦</span> <b><CountUp to={Number(state.reserves)} render={(n) => "$" + fmtAmount(BigInt(Math.round(n)))} /></b>&nbsp;held in reserve
            </span>
            <span className="trust-fact"><span className="ic" aria-hidden="true">⛓</span> Checked on Stellar, live</span>
          </div>
        )}
      </div>

      {/* the promise, in plain words */}
      <div className="promise">
        <div className="promise-card">
          <div className="promise-ic" aria-hidden="true">🪙</div>
          <h3>Every dollar matched</h3>
          <p>
            For every dollar customers are owed, a real dollar sits in the reserve. If it ever falls
            short, the proof simply fails — it can't be faked.
          </p>
        </div>
        <div className="promise-card">
          <div className="promise-ic" aria-hidden="true">🔎</div>
          <h3>Checked live, not promised</h3>
          <p>
            No audit firm, no quarterly PDF, no waiting. The check runs on the blockchain and anyone
            can re-run it any second — including you, right here.
          </p>
        </div>
        <div className="promise-card">
          <div className="promise-ic" aria-hidden="true">🛡️</div>
          <h3>Your privacy protected</h3>
          <p>
            No one's balance or identity is ever exposed — not even to prove the total adds up. That's
            the "zero-knowledge" part working for you.
          </p>
        </div>
      </div>

      {/* how it works */}
      <div className="how" id="how">
        <h2>How do we know it's really backed?</h2>
        <p className="how-sub">
          Three steps turn "trust us" into "check for yourself" — no finance or crypto knowledge needed.
        </p>
        <div className="steps">
          <div className="step">
            <div className="step-num">1</div>
            <h4>Reserves go on-chain</h4>
            <p>
              {ISSUER_NAME} holds the reserves in a <span className="emph">public vault</span> on
              Stellar. The amount is visible to everyone, all the time.
            </p>
          </div>
          <div className="step">
            <div className="step-num">2</div>
            <h4>Math checks the books</h4>
            <p>
              A <span className="emph">zero-knowledge proof</span> confirms the reserves cover every
              single customer — without revealing anyone's account or balance.
            </p>
          </div>
          <div className="step">
            <div className="step-num">3</div>
            <h4>You can re-check it</h4>
            <p>
              The result is posted on-chain and <span className="emph">re-checked live</span> on this
              page. If it isn't fresh and passing, the operator can't move money out.
            </p>
          </div>
        </div>
      </div>

      {/* backing over time — consumer framed */}
      {state && (
        <div className="panel">
          <h2>Backing over time</h2>
          <p className="sub">
            How comfortably reserves have covered what's owed, check after check. Above the line is
            healthy; the red line is the danger point where backing would run out.
          </p>
          <MarginChart points={state.history} />
        </div>
      )}

      {/* verify it yourself — technical drawer */}
      {state && (
        <div className={`drawer${techOpen ? " open" : ""}`}>
          <button
            className="drawer-head"
            onClick={() => setTechOpen((o) => !o)}
            aria-expanded={techOpen}
          >
            <span className="drawer-title">
              Verify it yourself
              <small>The on-chain proof, contract, and the public-vs-private split — for the curious.</small>
            </span>
            <span className="drawer-chev" aria-hidden="true">▼</span>
          </button>
          {techOpen && (
            <div className="drawer-body">
              <div className="grid">
                <div className="stat">
                  <div className="label">On-chain reserves</div>
                  <div className="value"><CountUp to={Number(state.reserves)} render={(n) => fmtAmount(BigInt(Math.round(n)))} /></div>
                </div>
                <div className="stat">
                  <div className="label">Owed floor (net_custodied)</div>
                  <div className="value"><CountUp to={Number(state.netCustodied)} render={(n) => fmtAmount(BigInt(Math.round(n)))} /></div>
                </div>
                <div className="stat">
                  <div className="label">Proven backing</div>
                  <div className="value">{state.attestation ? `≥ ${fmtBps(state.attestation.ratio_bps)}` : "—"}</div>
                </div>
                <div className="stat">
                  <div className="label">Freshness</div>
                  <div className="value">
                    {state.attestation ? (
                      state.fresh ? <span className="pill green">FRESH</span> : <span className="pill amber">STALE</span>
                    ) : <span className="pill gray">—</span>}
                  </div>
                </div>
                <div className="stat">
                  <div className="label">Enforcement</div>
                  <div className="value"><span className={`pill ${enforced ? "green" : "gray"}`}>{enforced ? "ENFORCED" : "ATTEST-ONLY"}</span></div>
                </div>
                <div className="stat">
                  <div className="label">Epoch</div>
                  <div className="value"><CountUp to={state.epoch} render={(n) => Math.round(n).toString()} /></div>
                </div>
              </div>

              {state.attestation && (
                <div className="split mt">
                  <div className="col">
                    <h3>Public (on the blockchain)</h3>
                    <div className="kv"><span className="k">verdict</span><span className="v" style={{ color: "var(--safe-deep)" }}>{state.attestation.solvent ? "SOLVENT" : "INSOLVENT"}</span></div>
                    <div className="kv"><span className="k">reserves</span><span className="v">{fmtAmount(state.attestation.reserves)}</span></div>
                    <div className="kv"><span className="k">min backing ratio</span><span className="v">{fmtBps(state.attestation.ratio_bps)}</span></div>
                    <div className="kv"><span className="k">recorded at ledger</span><span className="v">{state.attestation.ledger}</span></div>
                  </div>
                  <div className="col">
                    <h3>Private (never revealed)</h3>
                    <div className="kv"><span className="k">each customer balance</span><span className="v">🔒 hidden</span></div>
                    <div className="kv"><span className="k">total liabilities</span><span className="v">🔒 hidden</span></div>
                    <div className="kv"><span className="k">number of customers</span><span className="v">🔒 hidden</span></div>
                    <div className="kv"><span className="k">any identity</span><span className="v">🔒 hidden</span></div>
                  </div>
                </div>
              )}

              {state.attestation && (
                <div className="kv mt">
                  <span className="k">fingerprint of the books (liabilities_root)</span>
                  <span className="v"><CopyId value={bytesToHex(state.attestation.liabilities_root)} /></span>
                </div>
              )}
              <div className="kv">
                <span className="k">vault contract</span>
                <span className="v">
                  <a href={contractUrl(VAULT_ID)} target="_blank" rel="noreferrer">{shortId(VAULT_ID)} ↗</a>
                </span>
              </div>

              <div style={{ marginTop: 18 }}>
                <PartnerGate state={state} />
              </div>
            </div>
          )}
        </div>
      )}

      <p className="small muted center">
        Everything on this page is read straight from the Stellar blockchain — there's no server in
        the middle, and the green state is the ledger's, not ours.
      </p>
    </>
  );
}
