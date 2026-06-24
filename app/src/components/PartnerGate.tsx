import type { VaultState } from "../lib/stellar.ts";
import { isWindDown } from "../lib/stellar.ts";

// F3: mirrors what a partner Soroban contract sees when it calls
// `require_fresh_attestation(max_age)` to gate its own logic on this custodian.
// Green = the partner's call succeeds; red = it reverts.
export default function PartnerGate({ state }: { state: VaultState }) {
  const att = state.attestation;
  const accepts =
    !!att && att.solvent && state.fresh && !isWindDown(state.status);

  return (
    <div className="panel">
      <h2>Partner gate (composability)</h2>
      <p className="sub">
        Any Soroban contract can call <code>require_fresh_attestation(max_age)</code> to refuse to
        integrate with a custodian that isn't provably solvent <em>right now</em>. This is what they'd see:
      </p>

      <div className="gate">
        <div className="gate-code">
          <div className="gate-code-head">PartnerContract.rs</div>
          <pre>
            <span className="c-com">// trap if the custodian isn't fresh-solvent</span>
            {"\n"}
            <span className="c-kw">let</span> ok = ballast
            {"\n    "}.<span className="c-fn">require_fresh_attestation</span>(max_age);
            {"\n"}
            <span className="c-com">// ↓ resolves to</span>
            {"\n"}
            <span className={accepts ? "c-ok" : "c-bad"}>
              {accepts ? "Ok(()) → continue" : "panic! → revert"}
            </span>
          </pre>
        </div>

        <div className={`verdict ${accepts ? "solvent" : "bad"} gate-verdict`}>
          <div className="dot" />
          <div>
            <div className="big">{accepts ? "PARTNER ACCEPTS" : "PARTNER REJECTS"}</div>
            <div className="note">
              {accepts
                ? "require_fresh_attestation succeeds — a fresh, solvent, healthy credential is on-chain."
                : "require_fresh_attestation reverts — no fresh solvent credential (stale, insolvent, or wind-down). The partner's transaction fails atomically."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
