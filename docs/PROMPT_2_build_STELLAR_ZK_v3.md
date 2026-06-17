# PROMPT 2 (FILLED v3 for "Stellar Hacks: Real-World ZK") — give to Claude Code to BUILD Ballast

v3 changes: adds the flagship features from `docs/FEATURES_ADDENDUM.md` (tiered so the core ships first), and **removes all demo/video responsibility** — the user records the flow themselves. Smoke tests are functional checks only.

Run Prompt 1 (harvest) first; the spec set (`CLAUDE.md`, `docs/MASTER_SPEC.md`, `docs/API_APPENDIX.md`, `docs/FEATURES_ADDENDUM.md`, `docs/FRONTEND_ATTACK_PLAN.md`) should already be in place. Confirm two environment specifics before P0: the **reserve stablecoin / SAC contract id**, and the current **testnet ledger close time** (for the staleness window).

Expected folder:
```
ballast/
├─ CLAUDE.md
├─ .env                 # never commit
├─ contracts/          # Soroban: vault (+ policy + verifier integration), oracle view
├─ guest/              # RISC Zero zkVM audit program (Rust) + prover host/service
├─ app/                # issuer dashboard, public verifier page, holder inclusion page
├─ docs/               # MASTER_SPEC, API_APPENDIX, FEATURES_ADDENDUM, FRONTEND_ATTACK_PLAN
└─ research/RESEARCH_FULL.md   # from Prompt 1
```

---

Read `CLAUDE.md` first, then `docs/` in the order it lists, before writing code. `research/RESEARCH_FULL.md` (and the cloned repos under `github/`) is the source of truth — **verify every Stellar/Soroban host function, `soroban-sdk` API, `stellar` CLI command, and the `stellar-risc0-verifier` interface against it (or the live docs) before using it. Never invent an API, host function, or receipt format.** If unsure how the RISC Zero receipt/journal/image-id is passed to the verifier, or the exact Poseidon host-fn signatures, check the harvested material — do not guess.

We are building the real, working v1 of **Ballast — a solvency-enforcing reserve vault for Stellar stablecoin custodians.** A custodian holds pooled stablecoin reserves in a Soroban vault and keeps a *private* internal per-user ledger; Ballast proves in zero-knowledge that reserves ≥ liabilities without revealing the book, verifies the proof on-chain, and **enforces** solvency by gating reserve outflows. **No mocks in the production path.** Honor the non-negotiables in `CLAUDE.md` throughout (ZK load-bearing over a hidden book; single-asset on-chain custody = no oracle; `L ≥ net_custodied`; enforce-don't-attest with operator-only staleness; keep `L` private; RISC Zero — no per-app trusted setup; defensive only; verify every API).

Use the model/credential wiring in `.env` exactly (see `CLAUDE.md`). Do not introduce paid accounts or services the spec didn't call for.

This is a **functional build, not a demo build.** Do NOT create a demo script, narrated walkthrough, video, or any presentation artifact — the user will record the flow themselves. Smoke tests below are functional pass/fail checks the user can run; they prove the system works, nothing more.

## Build order — stop for review at the end of each phase with a functional smoke test (real proofs through a real testnet contract, not just "it compiles").

**Core (build and verify these first, in order):**

- **P0 — Toolchain + testnet skeleton.** Install Rust, `stellar` CLI, RISC Zero (`cargo-risczero`/`r0vm`); install the Stellar Dev Skill. Scaffold a Soroban contract, create + Friendbot-fund a testnet identity, deploy hello-world, and clone/deploy the Nethermind `stellar-risc0-verifier` to testnet. **Smoke:** a successful `stellar contract invoke` on testnet (tx hash) + the verifier contract id.
- **P1 — Vault: custody + flow accounting.** Deposit/withdraw the reserve SAC token; maintain `net_custodied` from on-chain flows; `epoch`; events. **Smoke:** deposits and operator/user withdrawals move `net_custodied` correctly on testnet (show state + txs).
- **P2 — RISC Zero audit guest.** In Rust: ingest a private book, build a Poseidon Merkle **sum** tree, enforce balances ≥ 0, compute `L = Σ balances`, output journal = {liabilities_root, ratio result, floor result, result, epoch, domain} with **`L` kept private**. **Smoke:** receipt verifies off-chain for a valid book; fails for a tampered one (negative balance / altered leaf / wrong sum).
- **P3 — On-chain verification + attestation.** Wrap to Groth16; verify the receipt in the Vault via `stellar-risc0-verifier` against the pinned `image_id`; enforce `vault_reserves ≥ L`, `L ≥ net_custodied`, and the epoch/domain anti-replay binding; record the attestation; emit event. **Smoke:** Vault records SOLVENT for a valid proof and rejects a tampered/insolvent/replayed one, on testnet, with tx hashes.
- **P4 — Enforcement + staleness.** Gate `withdraw_operator` on a fresh proof; revert any breach; implement the staleness window (operator-only lock; `withdraw_user` always allowed); `AttestationOnly` vs `Enforced` tier switch. **Smoke:** an operator withdrawal that would breach the floor reverts on-chain; a safe one succeeds; user withdrawal succeeds even when the operator is locked.
- **P5 — Inclusion + public re-verification.** Client-side Merkle inclusion check against the published root (no leaf on-chain); a public read path that re-derives the latest attestation from chain state alone. **Smoke:** a user verifies inclusion locally; an unrelated party confirms the latest SOLVENT/INSOLVENT state purely from chain.

**Features (per `docs/FEATURES_ADDENDUM.md` — build only after the core happy-path + inclusion work end-to-end; follow the tiers):**

- **P6 — v1 core-plus features.**
  - **F2 over-collateralization ratio:** prove `reserves ≥ ratio × L` for a public `ratio`; store `ratio`; expose on the credential. **Smoke:** a book passing 1:1 but failing 105% returns INSOLVENT at ratio=105%.
  - **F3 composable credential + oracle:** maintain an on-chain "Proof of Solvency" credential `{ratio, ledger, result, margin}`; add `require_fresh_attestation(max_age)` for other contracts. Ship a tiny separate "partner gate" contract that calls it. **Smoke:** the partner contract accepts a custodian with a fresh SOLVENT attestation and reverts against a stale/insolvent one, on testnet.
  - **F4 solvency-margin history:** append each attestation to a bounded ring buffer (mind storage TTL/archival); expose a read for the time series. **Smoke:** N attestations produce a correctly ordered, length-capped history readable from chain.
- **P7 — v1-if-time feature.**
  - **F5 insolvency circuit-breaker + pro-rata exit:** a `Status {Healthy, WindDown}` flag set by `post_attestation`/staleness; in WindDown, operator outflows hard-locked and `withdraw_user` pays out pro-rata against remaining reserves. **Smoke:** an INSOLVENT attestation flips status to WindDown; operator outflow reverts; two users each withdraw the correct pro-rata amount on testnet.
- **P8 — stretch features (only if the above are solid; each reuses an existing Stellar pattern).**
  - **F1 auditor view-key disclosure:** encrypt book/openings to a designated auditor key; publish a ciphertext commitment as a public input; prove in-circuit it decrypts to the same leaves behind `liabilities_root`. **Smoke:** the auditor key recovers the exact book; no other party can; the proof still verifies on-chain.
  - **F6 sanctions non-membership:** reuse the Stellar Private Payments ASP non-membership (sparse Merkle) pattern; prove every account in the book is absent from a published deny-set root. **Smoke:** a book containing a denied account fails; a clean book passes, on testnet.

- **P9 — Frontend (functional surfaces, no demo content).** Build the three surfaces from `docs/FRONTEND_ATTACK_PLAN.md` (public verifier, holder inclusion, issuer dashboard) wired to testnet. Load `/mnt/skills/public/frontend-design/SKILL.md` before implementing UI. Expose the feature states (ratio/margin/status/partner-gate) as real, chain-backed UI — but do **not** script or narrate a demo; just make the states reachable so the user can record their own flow. **Smoke:** a non-author can, from the README alone, run each surface against the deployed testnet contracts and reach every state (SOLVENT, stale, INSOLVENT/WindDown, included/not-included).

- **P10 — Hardening + handoff (no demo).** Tests (unit + negative-path: tampered input, stale/replayed proof, breach attempt); run OpenZeppelin Soroban detectors; honest README that labels every residual assumption (per-user completeness, staleness window, any off-chain reserves, reliance on RISC Zero's one-time ceremony, "research prototype — not audited, testnet only") and lists deployed testnet contract ids. **Smoke:** a fresh clone builds and runs from the README alone; the full chain flow (deposit → prove → verify → enforce → public re-verify → user exit) works on testnet.

## Rules of engagement
- Missing credential/account/RPC/asset → **stop and ask me; don't stub or fake around it.**
- Live docs beat our `docs/` appendix on conflict; note the discrepancy and proceed.
- Secret keys never in code/logs/output; never commit `.env`.
- Small, phase-scoped commits; open-source from commit one; OSI license per the spec.
- After P10: a short "how to run" and the deployed testnet contract ids; a list of anything left `(confirm)` or TODO (incl. whether large-book proving needs RISC Zero Continuations). **No demo deliverables.**

Begin with P0.
