import { useState } from "react";
import {
  hexToBytes,
  verifyInclusion,
  type InclusionProof,
} from "../lib/sumtree.ts";
import { readView } from "../lib/stellar.ts";
import { SAMPLE_PROOF, SAMPLE_ROOT } from "../lib/sampleProof.ts";
import { bytesToHex, fmtAmount } from "../lib/format.ts";
import type { Attestation } from "../lib/stellar.ts";

type Result =
  | { kind: "included"; balance: bigint }
  | { kind: "excluded" }
  | { kind: "error"; msg: string }
  | null;

export default function HolderInclusion() {
  const [proofText, setProofText] = useState(
    JSON.stringify(SAMPLE_PROOF, null, 2),
  );
  const [rootHex, setRootHex] = useState(SAMPLE_ROOT);
  const [result, setResult] = useState<Result>(null);
  const [busy, setBusy] = useState(false);

  async function loadRootFromChain() {
    setBusy(true);
    setResult(null);
    try {
      const att = (await readView("latest_attestation")) as Attestation | null;
      if (!att) {
        setResult({
          kind: "error",
          msg: "No attestation on chain yet — paste/keep the sample root for now.",
        });
        return;
      }
      setRootHex(bytesToHex(att.liabilities_root));
    } catch (e) {
      setResult({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setResult(null);
    try {
      const proof = JSON.parse(proofText) as InclusionProof;
      const root = hexToBytes(rootHex);
      if (root.length !== 32) throw new Error("root must be 32 bytes of hex");
      const ok = await verifyInclusion(proof, root);
      if (ok) {
        setResult({ kind: "included", balance: BigInt(proof.leaf.balance) });
      } else {
        setResult({ kind: "excluded" });
      }
    } catch (e) {
      setResult({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  function loadSample() {
    setProofText(JSON.stringify(SAMPLE_PROOF, null, 2));
    setRootHex(SAMPLE_ROOT);
    setResult(null);
  }

  function tamper() {
    try {
      const p = JSON.parse(proofText) as InclusionProof;
      p.leaf.balance = BigInt(p.leaf.balance) + 1n + "";
      setProofText(JSON.stringify(p, null, 2));
      setResult(null);
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Holder inclusion</h2>
        <p className="sub">
          "Is my balance counted in the proof?" — checked entirely on this device. Your leaf
          (account, balance, salt) never leaves the browser and never touches the chain.
        </p>

        <div className="banner">
          🔒 This runs <strong>locally</strong>. We fold your leaf up the Merkle sum-tree and
          compare to the published <code>liabilities_root</code>. Nothing is sent anywhere.
        </div>

        <label className="field">
          <span>Your inclusion proof (JSON from `ballast-inclusion prove`)</span>
          <textarea
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Published liabilities_root (hex)</span>
          <input
            type="text"
            value={rootHex}
            onChange={(e) => setRootHex(e.target.value)}
            spellCheck={false}
          />
        </label>

        <div className="row">
          <button className="btn" onClick={() => void verify()} disabled={busy}>
            {busy ? "Checking…" : "Verify inclusion"}
          </button>
          <button className="btn secondary" onClick={() => void loadRootFromChain()} disabled={busy}>
            Load root from chain
          </button>
          <button className="btn secondary" onClick={loadSample} disabled={busy}>
            Reset to sample
          </button>
          <button className="btn secondary" onClick={tamper} disabled={busy}>
            Tamper balance (+1)
          </button>
        </div>

        {result && (
          <div className="mt">
            {result.kind === "included" && (
              <div className="verdict solvent">
                <div className="dot" />
                <div>
                  <div className="big">✓ INCLUDED</div>
                  <div className="note">
                    Your balance of {fmtAmount(result.balance)} is committed under this root. The
                    custodian cannot have omitted you without changing the root the world sees.
                  </div>
                </div>
              </div>
            )}
            {result.kind === "excluded" && (
              <div className="verdict bad">
                <div className="dot" />
                <div>
                  <div className="big">✗ NOT INCLUDED</div>
                  <div className="note">
                    This leaf does not fold to the published root — a different balance, a wrong
                    salt, or the wrong root. The custodian's claim does not cover this entry.
                  </div>
                </div>
              </div>
            )}
            {result.kind === "error" && <div className="error mt">⚠ {result.msg}</div>}
          </div>
        )}
      </div>

      <p className="small muted center">
        Same SHA-256 sum-tree as the RISC Zero guest (<code>ballast-core</code>) — the holder check
        and the proof can never drift.
      </p>
    </>
  );
}
