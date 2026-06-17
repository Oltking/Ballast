# BALLAST — FEATURES_ADDENDUM.md

Extends `MASTER_SPEC.md`. Each feature is rated **build cost** (how much it adds to circuit/contract/UI) and **demo value**, with a clear v1/stretch/v2 recommendation. The guiding rule: nothing here may violate the non-negotiables — every feature must keep the ZK load-bearing over a *hidden* book and must not introduce an oracle into the trustless core.

## Recommended tiers (decisive)

- **v1 core-plus (build these — cheap, high impact):** F2 over-collateralization ratio, F3 composable solvency credential + oracle, F4 solvency-margin history feed.
- **v1 if time (high narrative payoff):** F5 insolvency circuit-breaker + pro-rata user exit.
- **Stretch / strongest "wow" (reuses existing Stellar patterns):** F1 auditor view-key disclosure, F6 sanctions non-membership.
- **v2 (forward-looking, dependency-gated):** F7 O(1) homomorphic aggregate.

---

## F1 — Auditor view-key selective disclosure
**What:** A designated auditor/regulator key can recover the full per-user book (or a scoped slice) while the public sees only the proof. Grounded in a first-class Stellar concept: Privacy Pools on Stellar already describe **view keys** for authorized investigators [corpus-verified, Privacy docs].
**How:** The prover encrypts the book (or per-leaf openings) to the auditor's public key and publishes the ciphertext commitment as a public input; the circuit proves the ciphertext decrypts to the same leaves that formed `liabilities_root`. The auditor decrypts off-chain; nobody else learns anything.
**Why it matters:** This is the literal "compliance-forward, privacy-preserving" pitch the SDF states as the reason these primitives exist. Turns Ballast from "trust me" into "private to the world, fully open to the regulator."
**Build cost:** High (encryption-to-key + in-circuit consistency proof + key mgmt). **Demo value:** Very high (show auditor unlocking detail nobody else can see). **Tier:** Stretch.

## F2 — Over-collateralization ratio proof
**What:** Prove `reserves ≥ ratio × L` for a public `ratio` (100% = GENIUS-Act 1:1; 105%/110% = buffer), not just `reserves ≥ L`.
**How:** One extra comparison in the guest using the public `ratio`; `ratio` stored on the vault and shown on the badge.
**Why it matters:** "Provably 105% backed" is a stronger, marketable claim and matches how regulated issuers actually talk about reserves.
**Build cost:** Trivial (one constraint). **Demo value:** High. **Tier:** v1 core-plus.

## F3 — Composable solvency credential + on-chain oracle
**What:** (a) Each accepted attestation updates an on-chain **"Proof of Solvency" credential** (`{ratio, ledger, result, margin}`) that any third party can read; (b) a `require_fresh_attestation(max_age)` view other Soroban contracts can call to **gate** their own logic on a custodian's current solvency.
**How:** Pure contract additions over the attestation record already in the Vault; no circuit change.
**Why it matters:** Turns Ballast from an app into **infrastructure** — a DeFi protocol, a payment partner, or a marketplace can refuse to integrate with a custodian that isn't provably solvent *right now*. This is the "platform, not a demo" story judges reward.
**Build cost:** Low. **Demo value:** High (show a second contract reading Ballast and reverting against a stale/insolvent custodian). **Tier:** v1 core-plus.

## F4 — Solvency-margin history feed
**What:** The registry keeps a bounded ring buffer of recent attestations; the public page renders a time series of **solvency margin** (`reserves − L*`) and ratio per epoch.
**How:** Append-on-attest in contract storage (cap length for rent); chart in the frontend.
**Why it matters:** Converts point-in-time PoR into a **monitored health feed** — the thing that would actually have flagged FTX trending toward insolvency. Great visual.
**Build cost:** Low. **Demo value:** High (a trend line that dips toward the danger zone, then the breaker fires). **Tier:** v1 core-plus.

## F5 — Insolvency circuit-breaker + pro-rata user exit
**What:** If an attestation returns `INSOLVENT`, or the attestation goes stale in Enforced mode, the vault auto-enters **wind-down**: all operator outflows hard-locked; users withdraw **pro-rata** against remaining reserves.
**How:** A `Status { Healthy, WindDown }` flag set by `post_attestation`/staleness check; `withdraw_user` switches to pro-rata math in WindDown.
**Why it matters:** This is the actual safety payoff — insolvency becomes a *handled state with an orderly user exit*, not a bank run. It's the emotional climax of the demo.
**Build cost:** Medium. **Demo value:** Very high. **Tier:** v1 if time.

## F6 — Sanctions / deny-list non-membership (solvency + AML in one proof)
**What:** Alongside solvency, prove **every account in the book is NOT on a published sanctions/deny set** — without revealing the book.
**How:** Reuse the Stellar Private Payments **ASP non-membership** pattern (sparse Merkle tree of blocked addresses) [corpus-verified — SPP ships an ASP non-membership contract]; the guest proves non-membership for each leaf against the published deny-set root.
**Why it matters:** Bundles the two things regulators demand — solvency *and* AML screening — into a single private attestation. Strongly differentiating and directly on the "compliance-forward" thesis.
**Build cost:** Medium-high (extra circuit logic + deny-set root maintenance). **Demo value:** Very high. **Tier:** Stretch (reuses an existing pattern, so more feasible than it sounds).

## F7 — O(1) homomorphic aggregate (v2)
**What:** When a confidential-token-style additively-homomorphic on-chain liability aggregate exists, the *contract* maintains `Σ balances` by construction — closing per-user completeness with zero user vigilance and making solvency checks O(1).
**Dependency:** Confidential Tokens on Stellar are **encryption-based and "in progress"** [corpus-verified] — do not assume availability. **Tier:** v2.

---

## Circuit/contract impact summary

| Feature | Circuit change | Contract change | Frontend change |
|---|---|---|---|
| F2 ratio | +1 comparison | store `ratio`, show on badge | badge label |
| F3 credential+oracle | none | credential struct + `require_fresh_attestation` view | "verified" seal; demo gating contract |
| F4 margin feed | none | append attestation history (bounded) | trend chart |
| F5 breaker | none | `Status` flag + pro-rata `withdraw_user` | status banner + pro-rata exit |
| F1 view key | encryption consistency proof | store ciphertext commitment | auditor unlock view |
| F6 non-membership | per-leaf non-membership | deny-set root admin | "AML-clean" badge |

## Demo arc with features (3 minutes)

1. Issuer loads a book → publishes attestation → public page shows **SOLVENT, 105% backed** (F2) and the margin trend (F4).
2. A partner contract calls `require_fresh_attestation` and **accepts** the custodian (F3).
3. Issuer tries to over-withdraw reserves → vault **reverts** (enforcement).
4. Issuer hides a whale to fake solvency → `L ≥ net_custodied` fails / inclusion fails → **INSOLVENT** → breaker trips → wind-down, **users still withdraw pro-rata** (F5); the partner contract now **rejects** the custodian (F3). That contrast is the closer.
