// Ballast landing — "the bank that proves it". Public front door: the pitch,
// a LIVE proof-of-reserves number read straight from the vault, and the three
// things a customer can do. (Starter — richer marketing polish welcome.)
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { loadVaultState } from "../lib/stellar.ts";
import { RESERVE_DECIMALS } from "../lib/config.ts";

function usd(stroops: bigint): string {
  const n = Number(stroops) / 10 ** RESERVE_DECIMALS;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function Landing() {
  const [reserves, setReserves] = useState<bigint | null>(null);
  const [fresh, setFresh] = useState<boolean>(false);
  const [solvent, setSolvent] = useState<boolean>(false);

  useEffect(() => {
    let live = true;
    loadVaultState()
      .then((s) => {
        if (!live) return;
        setReserves(s.reserves);
        setFresh(s.fresh);
        setSolvent(Boolean(s.attestation?.solvent));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="landing">
      <section className="hero" style={{ textAlign: "center", padding: "48px 0 8px" }}>
        <h2 style={{ fontSize: 44, lineHeight: 1.1, margin: "0 0 14px", letterSpacing: "-0.02em" }}>
          The bank that <span style={{ color: "var(--safe)" }}>proves it</span>.
        </h2>
        <p style={{ fontSize: 19, color: "var(--muted)", maxWidth: 620, margin: "0 auto 26px" }}>
          Hold dollars that are <strong>provably 100% backed</strong> — verified on-chain by a
          zero-knowledge proof, so you never have to trust us. Build a private credit passport and
          borrow against it, all in one place.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link to="/app" className="btn" style={{ padding: "13px 24px", fontSize: 16 }}>
            Open your account
          </Link>
          <Link to="/verify" className="btn secondary" style={{ padding: "13px 24px", fontSize: 16 }}>
            See the proof
          </Link>
        </div>
      </section>

      {/* Live proof-of-reserves */}
      <section className="panel" style={{ maxWidth: 560, margin: "26px auto", textAlign: "center" }}>
        <div className="pill" style={{ marginBottom: 10 }}>
          <span className="live" /> Live · Stellar testnet
        </div>
        <div style={{ fontSize: 40, fontWeight: 800 }}>
          {reserves === null ? "…" : `$${usd(reserves)}`}
        </div>
        <div style={{ color: "var(--muted)", fontWeight: 600 }}>
          in reserve, {solvent ? "provably covering every customer" : "attestation pending"}
          {fresh ? " · proof fresh" : " · proof refreshing"}
        </div>
        <Link to="/verify" style={{ display: "inline-block", marginTop: 12, fontWeight: 600 }}>
          Verify it yourself →
        </Link>
      </section>

      {/* Three things you can do */}
      <section
        className="grid"
        style={{ maxWidth: 960, margin: "18px auto 60px", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}
      >
        <div className="panel">
          <h3>Provably-safe account</h3>
          <p style={{ color: "var(--muted)" }}>
            Deposit USDC and see it counted in an audited set whose reserves are proven to cover
            everyone — without exposing anyone's balance. Withdraw anytime.
          </p>
          <Link to="/app" style={{ fontWeight: 600 }}>
            Open account →
          </Link>
        </div>
        <div className="panel">
          <h3>Private credit passport</h3>
          <p style={{ color: "var(--muted)" }}>
            Prove you're a trustworthy borrower — repaid loans, zero defaults — without revealing
            your history. A reputation you carry anywhere.
          </p>
          <Link to="/app" style={{ fontWeight: 600 }}>
            Build your passport →
          </Link>
        </div>
        <div className="panel">
          <h3>Borrow &amp; build credit</h3>
          <p style={{ color: "var(--muted)" }}>
            Take a loan, repay it, and grow your on-chain credit standing — which unlocks your
            passport and better terms over time.
          </p>
          <Link to="/app" style={{ fontWeight: 600 }}>
            Explore loans →
          </Link>
        </div>
      </section>
    </main>
  );
}
