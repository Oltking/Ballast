import { useCallback, useEffect, useState } from "react";
import {
  isEnforced,
  loadVaultState,
  type VaultState,
} from "../lib/stellar.ts";
import { VAULT_ID, contractUrl } from "../lib/config.ts";
import { bytesToHex, fmtAmount, fmtBps, shortId } from "../lib/format.ts";

type Verdict = "solvent" | "stale" | "bad" | "idle";

function verdictOf(s: VaultState): { kind: Verdict; label: string; note: string } {
  const att = s.attestation;
  if (!att) {
    return {
      kind: "idle",
      label: "NO ATTESTATION YET",
      note: "No solvency proof has been posted to this vault. Nothing to trust — and nothing claimed.",
    };
  }
  if (!att.solvent) {
    return {
      kind: "bad",
      label: "INSOLVENT",
      note: "The most recent proof did NOT establish reserves ≥ liabilities. The chain rejects the claim.",
    };
  }
  if (!s.fresh) {
    return {
      kind: "stale",
      label: "SOLVENT — but STALE",
      note: "The last proof is older than the freshness window. Operator outflows are locked until a fresh proof is posted; users can still withdraw.",
    };
  }
  return {
    kind: "solvent",
    label: "SOLVENT",
    note: "A fresh zero-knowledge proof establishes reserves ≥ liabilities, verified on-chain. Verify it yourself below.",
  };
}

export default function PublicVerifier() {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await loadVaultState());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const v = state ? verdictOf(state) : null;
  const enforced = state ? isEnforced(state.config) : false;
  const ledgersSince =
    state?.attestation != null
      ? state.latestLedger - state.attestation.ledger
      : null;

  return (
    <>
      <div className="panel">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <h2>Public verifier</h2>
          <button className="btn secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "Reading chain…" : "↻ Re-verify from chain"}
          </button>
        </div>
        <p className="sub">
          Independent trust from chain state alone — no server in the loop. Vault{" "}
          <a className="mono" href={contractUrl(VAULT_ID)} target="_blank" rel="noreferrer">
            {shortId(VAULT_ID)}
          </a>{" "}
          on Stellar testnet.
        </p>

        {error && <div className="error">⚠ {error}</div>}

        {v && (
          <div className={`verdict ${v.kind}`}>
            <div className="dot" />
            <div>
              <div className="big">{v.label}</div>
              <div className="note">{v.note}</div>
            </div>
          </div>
        )}

        {state && (
          <div className="grid mt">
            <div className="stat">
              <div className="label">On-chain reserves</div>
              <div className="value">{fmtAmount(state.reserves)}</div>
            </div>
            <div className="stat">
              <div className="label">Custodied floor (net_custodied)</div>
              <div className="value">{fmtAmount(state.netCustodied)}</div>
            </div>
            <div className="stat">
              <div className="label">Proven backing</div>
              <div className="value">
                {state.attestation ? `≥ ${fmtBps(state.attestation.ratio_bps)}` : "—"}
              </div>
            </div>
            <div className="stat">
              <div className="label">Epoch</div>
              <div className="value">{state.epoch}</div>
            </div>
            <div className="stat">
              <div className="label">Freshness</div>
              <div className="value">
                {state.attestation ? (
                  state.fresh ? (
                    <span className="pill green">FRESH</span>
                  ) : (
                    <span className="pill amber">STALE</span>
                  )
                ) : (
                  <span className="pill gray">—</span>
                )}
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
          </div>
        )}
      </div>

      {state?.attestation && (
        <div className="panel">
          <h2>What the chain reveals — and what it hides</h2>
          <p className="sub">
            The proof commits to the exact book yet exposes none of it. That contrast is the product.
          </p>
          <div className="split">
            <div className="col">
              <h3>Public (on-chain)</h3>
              <ul className="public">
                <li>Verdict: {state.attestation.solvent ? "SOLVENT" : "INSOLVENT"}</li>
                <li>Reserves: {fmtAmount(state.attestation.reserves)}</li>
                <li>Custodied floor: {fmtAmount(state.attestation.net_custodied)}</li>
                <li>Min ratio: {fmtBps(state.attestation.ratio_bps)}</li>
                <li>Epoch: {state.attestation.epoch}</li>
                <li>Recorded at ledger: {state.attestation.ledger}</li>
              </ul>
            </div>
            <div className="col">
              <h3>Hidden (never on-chain)</h3>
              <ul className="hidden-list">
                <li>Every individual customer balance</li>
                <li>The total liabilities L</li>
                <li>The number of customers</li>
                <li>Any customer identity</li>
              </ul>
            </div>
          </div>
          <div className="kv mt">
            <span className="k">liabilities_root</span>
            <span className="v">{bytesToHex(state.attestation.liabilities_root)}</span>
          </div>
          {ledgersSince != null && (
            <div className="kv">
              <span className="k">ledgers since proof</span>
              <span className="v">
                {ledgersSince} / {state.config.max_staleness_ledgers} window
              </span>
            </div>
          )}
        </div>
      )}

      <p className="small muted center">
        Reads are simulated against the public RPC; the green state is the ledger's, not ours.
      </p>
    </>
  );
}
