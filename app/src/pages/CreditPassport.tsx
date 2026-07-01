import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PASSPORT_PREDICATE_ID,
  addressToSubjectHex,
  getCredential,
  getPredicate,
  getRegistryConfig,
  isValid,
  type CredentialInfo,
  type PredicateInfo,
  type RegistryConfig,
} from "../lib/registry.ts";
import { server } from "../lib/stellar.ts";
import { useWallet } from "../lib/wallet-context.tsx";
import { REGISTRY_ID, VERIFIER_ROUTER, contractUrl } from "../lib/config.ts";
import { bytesToHex, errMsg, shortHex, shortId } from "../lib/format.ts";
import CopyId from "../components/CopyId.tsx";

// The live demo borrower whose passport is being recorded on-chain. 32 bytes of
// 0x11 — the issuer's chosen subject id for the sample "good standing" record.
const DEMO_SUBJECT_HEX =
  "1111111111111111111111111111111111111111111111111111111111111111";

type Tone = "safe" | "warn" | "idle";

interface Reading {
  predicate: PredicateInfo | null;
  credential: CredentialInfo | null;
  valid: boolean;
  config: RegistryConfig | null;
  latestLedger: number;
}

// ~5s per testnet ledger — turn a ledger delta into friendly time.
function agoText(ledgers: number): string {
  const secs = ledgers * 5;
  if (secs < 90) return "moments ago";
  if (secs < 3600) return `about ${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `about ${Math.round(secs / 3600)} h ago`;
  return `about ${Math.round(secs / 86400)} d ago`;
}

function windowText(ledgers: number): string {
  const secs = ledgers * 5;
  if (secs < 3600) return `~${Math.round(secs / 60)} min`;
  if (secs < 86400) return `~${Math.round(secs / 3600)} h`;
  return `~${Math.round(secs / 86400)} d`;
}

/** Verdict tone for a (credential, valid, predicate) reading. */
function verdictOf(
  cred: CredentialInfo | null,
  valid: boolean,
  pred: PredicateInfo | null,
  latestLedger: number,
): { tone: Tone; pill: string; cls: string } {
  if (!cred) return { tone: "idle", pill: "NO PASSPORT YET", cls: "gray" };
  const age = latestLedger > 0 && cred.ledger > 0 ? latestLedger - cred.ledger : 0;
  const stale = pred ? age > pred.fresh_window : false;
  if (valid && !stale) return { tone: "safe", pill: "GOOD STANDING ✓", cls: "green" };
  return { tone: "warn", pill: "NEEDS REFRESH", cls: "amber" };
}

export default function CreditPassport() {
  const [r, setR] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [predicate, credential, valid, config, ledger] = await Promise.all([
        getPredicate(PASSPORT_PREDICATE_ID),
        getCredential(DEMO_SUBJECT_HEX, PASSPORT_PREDICATE_ID),
        isValid(DEMO_SUBJECT_HEX, PASSPORT_PREDICATE_ID, 0),
        getRegistryConfig(),
        server.getLatestLedger(),
      ]);
      setR({ predicate, credential, valid, config, latestLedger: ledger.sequence });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const initialLoading = !r && loading;
  const v = r ? verdictOf(r.credential, r.valid, r.predicate, r.latestLedger) : null;
  const cred = r?.credential ?? null;
  const pred = r?.predicate ?? null;
  const age = r && cred && r.latestLedger > 0 ? r.latestLedger - cred.ledger : null;

  return (
    <>
      {/* who issues this passport */}
      <div className="issuer-id">
        <span className="issuer-logo">✦</span>
        <span className="issuer-meta">
          <span className="issuer-name">ZK Credit Passport</span>
          <br />
          <span className="issuer-kind">portable private reputation · Stellar testnet</span>
        </span>
      </div>

      {/* hero */}
      <div className={`trust-hero tone-${v?.tone ?? "idle"}`} aria-busy={initialLoading}>
        <div className="seal">
          <div className="seal-ring" />
          <div
            className={`seal-core ${initialLoading ? "seal-wait" : "seal-pop"}`}
            key={initialLoading ? "wait" : v?.tone}
            aria-hidden="true"
          >
            {initialLoading ? "" : v?.tone === "safe" ? "✓" : v?.tone === "warn" ? "↻" : "•"}
          </div>
        </div>
        <h1 className="trust-headline">
          A private, portable <span className="accent-safe">credit passport.</span>
        </h1>
        <p className="trust-sub">
          Prove you're a trustworthy borrower — you repaid your loans and never defaulted — without
          revealing your history, your numbers, or anyone else's. Only{" "}
          <strong>"trustworthy: yes"</strong> goes public; the actual counts stay private, by math.
        </p>
        {error && <div className="error mt">⚠ Couldn't reach the registry: {error}</div>}
        <div className="trust-cta">
          <a className="btn primary" href="#how">How does this work?</a>
          <button className="btn secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "Re-checking…" : "↻ Re-check now"}
          </button>
        </div>
        <div className="trust-facts">
          <span className="trust-fact"><span className="ic" aria-hidden="true">🔒</span> Counts stay private</span>
          <span className="trust-fact"><span className="ic" aria-hidden="true">🪪</span> One badge, every app</span>
          <span className="trust-fact"><span className="ic" aria-hidden="true">⛓</span> Recorded on Stellar</span>
        </div>
      </div>

      {/* the promise, plain words */}
      <div className="promise">
        <div className="promise-card">
          <div className="promise-ic" aria-hidden="true">🪪</div>
          <h3>Carry your reputation</h3>
          <p>
            Earn it once with one lender, use it everywhere. Any app can check your passport on-chain —
            no re-applying, no re-sharing your statements.
          </p>
        </div>
        <div className="promise-card">
          <div className="promise-ic" aria-hidden="true">🙈</div>
          <h3>Numbers stay yours</h3>
          <p>
            The proof confirms you cleared the bar — repaid ≥ a threshold, zero defaults — without ever
            publishing how many loans, how much, or who else is in the book.
          </p>
        </div>
        <div className="promise-card">
          <div className="promise-ic" aria-hidden="true">🔗</div>
          <h3>Can't be faked</h3>
          <p>
            The proof is bound to the lender's published record. Touch up your own history and the math
            stops matching — the passport simply won't issue.
          </p>
        </div>
      </div>

      {/* the live demo credential */}
      <div className="panel">
        <h2>The live demo passport</h2>
        <p className="sub">
          A real borrower's credential, recorded on-chain by the registry after a Groth16 proof was
          verified. This is read live — no server, no mock. {!cred && !initialLoading && "If it's blank, it's still being issued — give it a moment and re-check."}
        </p>

        <div className={`verdict ${v?.tone === "safe" ? "solvent" : v?.tone === "warn" ? "stale" : "idle"}`}>
          <div className="dot" />
          <div>
            <div className="big">
              {initialLoading
                ? "Reading the registry…"
                : !cred
                ? "Passport being issued"
                : v?.tone === "safe"
                ? "✓ Trustworthy borrower — good standing"
                : "Recorded — past its refresh window"}
            </div>
            <div className="note">
              {!cred
                ? "No credential recorded for this subject yet. A real Groth16 proof for it is being posted to the registry; this badge fills in the moment it lands."
                : v?.tone === "safe"
                ? "The borrower proved they repaid at least the threshold of loans with zero defaults. The verdict is public; every underlying number stays private."
                : "The credential is on-chain but older than the predicate's freshness window. The verdict still holds — it just may want a fresh proof."}
            </div>
          </div>
        </div>

        {cred && (
          <div className="grid mt">
            <div className="stat">
              <div className="label">Verdict</div>
              <div className="value"><span className={`pill ${v?.cls ?? "gray"}`}>{v?.pill}</span></div>
            </div>
            <div className="stat">
              <div className="label">Proven threshold</div>
              <div className="value">≥ {cred.param.toString()} loans</div>
            </div>
            <div className="stat">
              <div className="label">Recorded</div>
              <div className="value" style={{ fontSize: 16 }}>
                {age != null ? agoText(age) : "—"}
                <div className="small muted" style={{ fontWeight: 500, marginTop: 2 }}>ledger {cred.ledger}</div>
              </div>
            </div>
            <div className="stat">
              <div className="label">Freshness window</div>
              <div className="value" style={{ fontSize: 16 }}>
                {pred ? `${pred.fresh_window} ledgers` : "—"}
                <div className="small muted" style={{ fontWeight: 500, marginTop: 2 }}>{pred ? windowText(pred.fresh_window) : ""}</div>
              </div>
            </div>
          </div>
        )}

        {/* the public-vs-private split — exactly what's revealed */}
        <div className="split mt">
          <div className="col">
            <h3>Public (on-chain)</h3>
            <div className="kv"><span className="k">subject id</span><span className="v">{shortHex(DEMO_SUBJECT_HEX, 8, 6)}</span></div>
            <div className="kv"><span className="k">predicate</span><span className="v">{pred?.label || `#${PASSPORT_PREDICATE_ID}`}</span></div>
            <div className="kv"><span className="k">threshold proven</span><span className="v">≥ {cred ? cred.param.toString() : "—"}</span></div>
            <div className="kv"><span className="k">verdict</span><span className="v" style={{ color: "var(--safe-deep)" }}>{cred ? (r?.valid ? "VALID" : "RECORDED") : "—"}</span></div>
          </div>
          <div className="col">
            <h3>Private (never revealed)</h3>
            <div className="kv"><span className="k">exact loans repaid</span><span className="v">🔒 hidden</span></div>
            <div className="kv"><span className="k">amounts / dates</span><span className="v">🔒 hidden</span></div>
            <div className="kv"><span className="k">other borrowers</span><span className="v">🔒 hidden</span></div>
            <div className="kv"><span className="k">the full credit book</span><span className="v">🔒 hidden</span></div>
          </div>
        </div>

        {/* verifiable provenance */}
        <div className="mt">
          {pred && (
            <div className="kv">
              <span className="k">issuer's published root (anchor)</span>
              <span className="v"><CopyId value={bytesToHex(pred.anchor)} display={shortHex(bytesToHex(pred.anchor), 10, 8)} /></span>
            </div>
          )}
          {pred && (
            <div className="kv">
              <span className="k">guest program (image id)</span>
              <span className="v"><CopyId value={bytesToHex(pred.image_id)} display={shortHex(bytesToHex(pred.image_id), 10, 8)} /></span>
            </div>
          )}
          <div className="kv">
            <span className="k">credential registry</span>
            <span className="v"><a href={contractUrl(REGISTRY_ID)} target="_blank" rel="noreferrer">{shortId(REGISTRY_ID)} ↗</a></span>
          </div>
          <div className="kv">
            <span className="k">Groth16 verifier</span>
            <span className="v"><a href={contractUrl(VERIFIER_ROUTER)} target="_blank" rel="noreferrer">{shortId(VERIFIER_ROUTER)} ↗</a></span>
          </div>
        </div>
      </div>

      {/* check any account */}
      <CheckAny />

      {/* how it works */}
      <div className="how" id="how">
        <h2>How a passport is earned — and why it can't be faked</h2>
        <p className="how-sub">
          Three steps turn "trust my word" into "check the chain" — no crypto knowledge needed.
        </p>
        <div className="steps">
          <div className="step">
            <div className="step-num">1</div>
            <h4>The lender publishes a root</h4>
            <p>
              The lending protocol commits its credit book to a single{" "}
              <span className="emph">published fingerprint</span> (a Merkle root, the "anchor"). It
              never reveals the book itself.
            </p>
          </div>
          <div className="step">
            <div className="step-num">2</div>
            <h4>You prove, privately</h4>
            <p>
              A <span className="emph">zero-knowledge proof</span> shows your record is in that book
              and that you repaid ≥ the threshold with zero defaults — revealing only the yes/no.
            </p>
          </div>
          <div className="step">
            <div className="step-num">3</div>
            <h4>The chain records the badge</h4>
            <p>
              The registry verifies the proof and writes your passport on-chain. Any app reads it with
              one call — <span className="emph">is_valid(subject, predicate)</span>.
            </p>
          </div>
        </div>
        <div className="verdict bad mt" style={{ textAlign: "left" }}>
          <div className="dot" />
          <div>
            <div className="big" style={{ fontSize: 17 }}>Try to cheat? The math catches it.</div>
            <div className="note">
              Edit your own record to claim more repayments and the book's Merkle root no longer matches
              the lender's <strong>published anchor</strong>{pred ? <> (<span className="mono">{shortHex(bytesToHex(pred.anchor), 8, 6)}</span>)</> : ""}. The proof
              fails to verify, so no friendlier passport can ever be issued.
            </div>
          </div>
        </div>
      </div>

      {/* honest trust note */}
      <div className="panel">
        <h2>What you're trusting — honestly</h2>
        <p className="sub" style={{ maxWidth: "74ch" }}>
          The <strong>contents</strong> of the credit book are attested by the lending protocol that
          issues it — that's the one stated trust assumption. What the zero-knowledge proof guarantees:
          the numbers and every other borrower stay private, and the proof is{" "}
          <strong>bound on-chain to the issuer's published root</strong>, so no one — not even the
          holder — can fabricate a friendlier record. The registry is generic: the same verifier and
          pattern back the solvency vault and will back future predicates with no redeploy.
        </p>
      </div>

      <p className="small muted center">
        Everything here is read straight from the Stellar credential registry — there's no server in
        the middle, and the verdict is the ledger's, not ours. Research prototype · testnet only.
      </p>
    </>
  );
}

// ---- "Check any account" sub-surface ----

function CheckAny() {
  // Reuse the shared wallet connection — if you already connected in another
  // section, "Use my connected wallet" fills instantly with no second prompt.
  const { address, connect } = useWallet();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fillOnConnect, setFillOnConnect] = useState(false);
  const [result, setResult] = useState<
    | { subjectHex: string; valid: boolean; cred: CredentialInfo | null }
    | null
  >(null);

  // When the user asked to use their wallet but wasn't connected yet, fill the
  // input as soon as the shared connection lands.
  useEffect(() => {
    if (fillOnConnect && address) {
      setInput(address);
      setFillOnConnect(false);
    }
  }, [fillOnConnect, address]);

  const subjectHex = useMemo(() => {
    const s = input.trim();
    if (!s) return null;
    try {
      if (/^G[A-Z2-7]{55}$/.test(s)) return addressToSubjectHex(s);
      const hex = s.replace(/^0x/, "");
      if (/^[0-9a-fA-F]{64}$/.test(hex)) return hex.toLowerCase();
    } catch {
      /* fall through */
    }
    return null;
  }, [input]);

  async function useConnectedWallet() {
    setErr(null);
    if (address) {
      setInput(address);
      return;
    }
    setFillOnConnect(true);
    await connect();
  }

  async function check() {
    if (!subjectHex) {
      setErr("Enter a Stellar address (G…) or a 32-byte subject id (64 hex chars).");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const [valid, cred] = await Promise.all([
        isValid(subjectHex, PASSPORT_PREDICATE_ID, 0),
        getCredential(subjectHex, PASSPORT_PREDICATE_ID),
      ]);
      setResult({ subjectHex, valid, cred });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Check any account's passport</h2>
      <p className="sub">
        Paste a Stellar address (or use your wallet) and we'll ask the registry whether it holds a
        valid Credit Passport — the same check any app would run.
      </p>
      <div className="op-control">
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Stellar address (G…) or 32-byte subject id</span>
          <input
            type="text"
            value={input}
            placeholder="G… or 64 hex chars"
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button className="btn" disabled={busy || !subjectHex} onClick={() => void check()}>
          {busy ? "Checking…" : "Check passport"}
        </button>
      </div>
      <p className="small muted mt">
        <button className="linklike" style={{ paddingLeft: 0 }} onClick={() => void useConnectedWallet()}>
          Use my connected wallet
        </button>
        {subjectHex && (
          <>
            {" · "}subject id <span className="mono">{shortHex(subjectHex, 8, 6)}</span>
          </>
        )}
      </p>

      {err && <div className="error mt">⚠ {err}</div>}

      {result && (
        result.valid && result.cred ? (
          <div className="verdict solvent mt">
            <div className="dot" />
            <div>
              <div className="big">✓ Valid passport — good standing</div>
              <div className="note">
                This account holds a verified Credit Passport proving it repaid ≥{" "}
                <strong>{result.cred.param.toString()}</strong> loans with zero defaults. Recorded at
                ledger {result.cred.ledger}. The underlying numbers stay private.
              </div>
            </div>
          </div>
        ) : result.cred ? (
          <div className="verdict stale mt">
            <div className="dot" />
            <div>
              <div className="big">Recorded, but not currently valid</div>
              <div className="note">
                A credential exists (threshold ≥ {result.cred.param.toString()}, ledger{" "}
                {result.cred.ledger}) but it's past its freshness window. A fresh proof would restore it.
              </div>
            </div>
          </div>
        ) : (
          <div className="verdict idle mt">
            <div className="dot" />
            <div>
              <div className="big">No passport yet</div>
              <div className="note">
                This account has no Credit Passport on the registry. To get one, the holder's lender
                would enroll them in its published book and a proof would be recorded on-chain — no
                private data is ever exposed in the process.
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
