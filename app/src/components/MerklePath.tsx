import type { InclusionProof } from "../lib/sumtree.ts";
import { bytesToHex, shortHex, fmtAmount } from "../lib/format.ts";

// Visualizes the authentication path: the holder's own leaf folds upward,
// combining with one sibling hash per level, until it reaches the published
// root. Siblings are shown sealed — you prove membership without ever seeing
// another customer's balance.
export default function MerklePath({
  proof,
  ok,
}: {
  proof: InclusionProof;
  ok?: boolean;
}) {
  const steps = proof.path ?? [];
  const leafBal = (() => {
    try {
      return fmtAmount(BigInt(proof.leaf.balance));
    } catch {
      return "—";
    }
  })();
  const acct = shortHex(bytesToHex(proof.leaf.account), 6, 4);

  return (
    <div className="mp">
      {/* root */}
      <div className={`mp-root${ok ? " ok" : ok === false ? " bad" : ""}`}>
        <span className="mp-root-label">liabilities_root</span>
        <span className="mp-root-cap">{ok === false ? "mismatch ✗" : ok ? "match ✓" : "fold to compare"}</span>
      </div>

      <div className="mp-ladder">
        {[...steps].reverse().map((step, ri) => {
          const level = steps.length - ri; // top-most shown first
          const youLeft = step.is_left;
          return (
            <div className="mp-level" key={ri}>
              <div className="mp-conn" />
              <div className={`mp-pair${youLeft ? "" : " swap"}`}>
                <div className="mp-node you">
                  <span className="mp-node-k">your subtree</span>
                  <span className="mp-node-v">level {level}</span>
                </div>
                <div className="mp-plus">+</div>
                <div className="mp-node sib">
                  <span className="mp-node-k">🔒 sibling</span>
                  <span className="mp-node-v">{shortHex(bytesToHex(step.sibling_hash), 5, 3)}</span>
                </div>
              </div>
            </div>
          );
        })}

        {/* leaf */}
        <div className="mp-level">
          <div className="mp-conn" />
          <div className="mp-leaf">
            <span className="mp-leaf-icon">●</span>
            <div className="mp-leaf-body">
              <span className="mp-node-k">your leaf · {acct}</span>
              <span className="mp-node-v">balance {leafBal}</span>
            </div>
          </div>
        </div>
      </div>

      <p className="mp-note">
        {steps.length} sibling{steps.length === 1 ? "" : "s"} on the path — each a sealed subtree.
        You learn no one else's balance, yet the root can't omit you.
      </p>
    </div>
  );
}
