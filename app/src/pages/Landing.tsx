// Ballast landing — "the bank that proves it". Public front door: the pitch, a
// LIVE proof-of-reserves number read straight from the vault, plain-language
// "how it works", the zero-knowledge idea in warm terms, and the three things a
// customer can do. Live vault data is the star of the page.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { loadVaultState, isWindDown, type VaultState } from "../lib/stellar.ts";
import { RESERVE_DECIMALS, ISSUER_NAME } from "../lib/config.ts";

function usd(stroops: bigint): string {
  const n = Number(stroops) / 10 ** RESERVE_DECIMALS;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type ReserveTone = "safe" | "warn" | "risk" | "idle";

interface ReserveView {
  tone: ReserveTone;
  label: string;
  detail: string;
}

// Turn the raw vault state into a single reassuring line a normal person reads.
function reserveView(s: VaultState): ReserveView {
  const att = s.attestation;
  if (isWindDown(s.status)) {
    return {
      tone: "warn",
      label: "Fair wind-down in progress",
      detail: "Withdrawals are paid out proportionally to everyone — no bank run.",
    };
  }
  if (!att) {
    return {
      tone: "idle",
      label: "Awaiting first proof",
      detail: "No solvency claim has been published yet — nothing to take on trust.",
    };
  }
  if (!att.solvent) {
    return {
      tone: "risk",
      label: "Backing not confirmed",
      detail: "The latest check did not confirm full backing — treat with caution.",
    };
  }
  if (!s.fresh) {
    return {
      tone: "warn",
      label: "Proof refreshing",
      detail: `Backing was confirmed at epoch ${att.epoch}; a fresh proof is due. Your withdrawals are unaffected.`,
    };
  }
  return {
    tone: "safe",
    label: "✓ Provably backed",
    detail: `Reserves proven to cover every customer at epoch ${att.epoch} — checked live on Stellar.`,
  };
}

export default function Landing() {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let live = true;
    loadVaultState()
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const view = state ? reserveView(state) : null;
  const loading = !state && !error;

  return (
    <main className="landing">
      {/* 1 — Hero */}
      <section className="lp-hero">
        <span className="lp-eyebrow">
          <span className="live" /> Provably-solvent neobank · Stellar
        </span>
        <h2 className="lp-title">
          The bank that <span className="lp-accent">proves it</span>.
        </h2>
        <p className="lp-lede">
          Hold dollars that are <strong>provably 100% backed</strong> on-chain, build a{" "}
          <strong>private credit passport</strong>, and borrow to grow your standing — verified by a
          zero-knowledge proof, so you never have to trust us.
        </p>
        <div className="lp-cta">
          <Link to="/app" className="btn primary lp-btn">
            Open your account
          </Link>
          <Link to="/verify" className="btn secondary lp-btn">
            See the proof
          </Link>
        </div>
        <div className="lp-trustrow">
          <span className="trust-fact"><span className="ic" aria-hidden="true">🔒</span> No balances revealed</span>
          <span className="trust-fact"><span className="ic" aria-hidden="true">⛓</span> Checked live on-chain</span>
          <span className="trust-fact"><span className="ic" aria-hidden="true">↩</span> Withdraw anytime</span>
        </div>
      </section>

      {/* 2 — Live proof-of-reserves (the star) */}
      <section className={`lp-reserve tone-${view?.tone ?? "idle"}`} aria-busy={loading}>
        <div className="lp-reserve-top">
          <span className="pill gray lp-reserve-tag">
            <span className="live" /> Live · Stellar testnet
          </span>
          <span className="lp-reserve-issuer">{ISSUER_NAME} reserve</span>
        </div>

        {loading ? (
          <>
            <div className="sk-line sk-lg" style={{ margin: "8px auto 12px" }} />
            <div className="sk-line sk-md" />
            <span className="sk-caption">Reading the latest proof from Stellar…</span>
          </>
        ) : error || !state || !view ? (
          <>
            <div className="lp-reserve-num muted">—</div>
            <p className="lp-reserve-detail">
              We couldn't reach the network right now — your funds aren't affected. Give it a moment
              and try the verifier.
            </p>
          </>
        ) : (
          <>
            <div className="lp-reserve-num">${usd(state.reserves)}</div>
            <div className="lp-reserve-caption">held in reserve on-chain</div>
            <div className={`lp-reserve-badge tone-${view.tone}`}>{view.label}</div>
            <p className="lp-reserve-detail">{view.detail}</p>
          </>
        )}

        <Link to="/verify" className="lp-verify-link">
          Verify it yourself →
        </Link>
      </section>

      {/* 3 — How it works */}
      <section className="how" id="how">
        <h2>How Ballast works</h2>
        <p className="how-sub">
          Four simple steps turn "trust the bank" into "check it yourself" — no finance or crypto
          knowledge needed.
        </p>
        <div className="steps lp-steps">
          <div className="step">
            <div className="step-num">1</div>
            <h4>Deposit USDC</h4>
            <p>Fund your account with dollars. They join a pooled reserve held in a public on-chain vault.</p>
          </div>
          <div className="step">
            <div className="step-num">2</div>
            <h4>We prove it's covered</h4>
            <p>A <span className="emph">zero-knowledge proof</span> shows reserves cover every customer — without revealing anyone's balance.</p>
          </div>
          <div className="step">
            <div className="step-num">3</div>
            <h4>Build a passport</h4>
            <p>Prove "repaid loans, zero defaults" as a <span className="emph">private credit passport</span> you carry anywhere.</p>
          </div>
          <div className="step">
            <div className="step-num">4</div>
            <h4>Borrow &amp; grow</h4>
            <p>Take a loan, repay it, and grow your on-chain credit standing — unlocking better terms over time.</p>
          </div>
        </div>
      </section>

      {/* 4 — Why it's different / the ZK idea, warmly */}
      <section className="lp-why">
        <div className="lp-why-copy">
          <span className="lp-kicker">Why it's different</span>
          <h2>You don't have to trust us. You can check.</h2>
          <p>
            Most banks ask you to <em>believe</em> your money is safe. Ballast proves it. We show,
            with math, that we hold enough for <strong>everyone</strong> — without ever revealing any
            single customer's balance or identity. That's the "zero-knowledge" part working for you.
          </p>
          <p>
            The result is posted on the Stellar blockchain and re-checked live. If a proof isn't
            fresh and passing, the operator simply <strong>can't move reserves out</strong> — but your
            withdrawals are never blocked.
          </p>
          <details className="lp-details">
            <summary>How the proof actually works</summary>
            <p>
              Customer balances live in a private ledger, committed to a Merkle sum-tree whose root is
              public. A RISC Zero zkVM program proves <code>reserves ≥ total liabilities</code> against
              that root, and a Soroban contract verifies the proof on-chain and gates outflows on it.
              The total owed, individual balances, and customer count never leave the prover.
            </p>
          </details>
        </div>
        <div className="lp-why-visual" aria-hidden="true">
          <div className="lp-scale">
            <div className="lp-scale-side lp-scale-safe">
              <span className="lp-scale-amt">Reserves</span>
              <span className="lp-scale-sub">public · on-chain</span>
            </div>
            <div className="lp-scale-op">≥</div>
            <div className="lp-scale-side lp-scale-hidden">
              <span className="lp-scale-amt">🔒 Liabilities</span>
              <span className="lp-scale-sub">private · never revealed</span>
            </div>
          </div>
          <div className="lp-scale-note">Proven by a zero-knowledge proof, verified on Stellar.</div>
        </div>
      </section>

      {/* 5 — The three products */}
      <section className="lp-products">
        <h2 className="lp-section-title">One account, three ways to get ahead</h2>
        <div className="promise lp-promise">
          <div className="promise-card">
            <div className="promise-ic" aria-hidden="true">🪙</div>
            <h3>Provably-safe account</h3>
            <p>
              Deposit USDC into a reserve that's proven to cover everyone — without exposing anyone's
              balance. Withdraw anytime.
            </p>
            <Link to="/app" className="lp-card-link">Open account →</Link>
          </div>
          <div className="promise-card">
            <div className="promise-ic" aria-hidden="true">🛡️</div>
            <h3>Private credit passport</h3>
            <p>
              Prove you're a trustworthy borrower — repaid loans, zero defaults — without revealing
              your history. A reputation you carry anywhere.
            </p>
            <Link to="/app" className="lp-card-link">Build your passport →</Link>
          </div>
          <div className="promise-card">
            <div className="promise-ic" aria-hidden="true">📈</div>
            <h3>Borrow &amp; build credit</h3>
            <p>
              Take a loan, repay it, and grow your on-chain credit standing — which unlocks your
              passport and better terms over time.
            </p>
            <Link to="/app" className="lp-card-link">Explore loans →</Link>
          </div>
        </div>
      </section>

      {/* 6 — Closing CTA band */}
      <section className="lp-band">
        <h2>Banking you can verify, not just trust.</h2>
        <p>Open an account in minutes, or check the live proof for yourself first.</p>
        <div className="lp-cta">
          <Link to="/app" className="btn primary lp-btn">Open your account</Link>
          <Link to="/verify" className="btn secondary lp-btn">See the proof</Link>
        </div>
        <p className="lp-band-note">Research prototype · Stellar testnet only. Real proofs, real on-chain verification.</p>
      </section>
    </main>
  );
}
