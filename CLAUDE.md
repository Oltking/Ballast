# CLAUDE.md — Ballast

**Read this first, then read `docs/` in the order in §Reading order. `research/RESEARCH_FULL.md` is the source of truth; verify every Stellar/RISC Zero API against it (or the live docs / cloned repos) before using it. Never invent a host function, SDK signature, or verifier interface.**

## What we're building
**Ballast** — a solvency-enforcing reserve vault for Stellar stablecoin custodians. A custodian holds pooled stablecoin reserves in a Soroban vault and keeps a *private* internal per-user ledger. Ballast proves in zero-knowledge that **reserves ≥ liabilities** without revealing the book, verifies the proof in a Soroban contract, and **enforces** solvency by gating reserve outflows. Built for the "Stellar Hacks: Real-World ZK" hackathon.

## Reading order
1. `CLAUDE.md` (this file)
2. `docs/MASTER_SPEC.md` — product, threat model, architecture, contracts, the guest program, enforcement/staleness policy, build phases, source-of-truth checks
3. `docs/API_APPENDIX.md` — verified network config, host functions, CAPs, verifier interface, SAC, tools
4. `docs/FEATURES_ADDENDUM.md` — flagship features and their build tiers
5. `docs/FRONTEND_ATTACK_PLAN.md` — the three UI surfaces + the tamper demo
6. `research/RESEARCH_FULL.md` — raw harvested corpus (search it; don't trust memory)

## Non-negotiables (hard rules)
1. **ZK load-bearing over a hidden book.** Never build a variant where the liability set is public (that's just public arithmetic — no ZK needed).
2. **Single-asset, on-chain custody = no oracle.** Reserves = the vault contract's own on-chain balance of one stablecoin, read in-call. Off-chain/multi-asset reserves are OUT of the trustless core and must be labelled as a trust assumption wherever they appear.
3. **Bind the book to chain:** the proof enforces `L ≥ net_custodied`, where `net_custodied` is maintained on-chain from vault flows.
4. **Enforce, don't just attest:** outflows gated by a fresh proof; revert breaches. Staleness restricts the **operator only** — users can always withdraw.
5. **`L` stays private:** never write the liability total to the proof journal.
6. **Trust-minimized proving:** RISC Zero (inherited one-time Groth16 ceremony) — no per-app Circom trusted setup. Verify receipts via Nethermind's `stellar-risc0-verifier`.
7. **Defensive/legitimate only.** Never prompt users for seed phrases or secret keys.
8. **No mocks in the production path.** Anything temporarily stubbed must be labelled in the README (the hackathon explicitly prefers honest WIP).

## Environment (`.env` — never commit)
```
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org          # [corpus-verified]
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015 # [corpus-verified]
FRIENDBOT_URL=https://friendbot.stellar.org                  # [corpus-verified]
HORIZON_URL=https://horizon-testnet.stellar.org              # [corpus-verified]
SOURCE_ACCOUNT_SECRET=                # testnet identity, funded via Friendbot/Lab — never log
RESERVE_ASSET=                        # (confirm) testnet stablecoin wrapped as SAC; record contract id
RISC0_DEV_MODE=0                      # real proofs, not dev-mode fakes
BONSAI_API_KEY=                       # optional — only if proving via Bonsai instead of local r0vm
```

## Tech stack
- **Contracts:** Rust + `soroban-sdk` (compile to WASM), `stellar` CLI for build/deploy/invoke.
- **Proving:** RISC Zero zkVM guest in Rust (`cargo-risczero`/`r0vm`); STARK → Groth16 wrap; verify on-chain via the cloned `stellar-risc0-verifier`.
- **Hashing/commitments:** Poseidon/Poseidon2 host functions (CAP-0075) for the Merkle **sum** tree; BN254 host functions (CAP-0074) underpin Groth16 verification.
- **Frontend:** Stellar JS SDK + Stellar Wallets Kit; consider Scaffold Stellar to bootstrap. Load `/mnt/skills/public/frontend-design/SKILL.md` before implementing any UI.
- **Skills:** install/read the Stellar Dev Skill before building; it covers Soroban, RPC, wallets, security patterns.

## Build phases
Follow P0–P6 in `docs/` (and the build prompt). **Stop for review at the end of each phase** with a smoke test proving real proofs flow through a real testnet contract — not just that it compiles. Build the v1 core first; add features per `FEATURES_ADDENDUM.md` tiers only after the core happy-path + tamper demo work end-to-end.

## Source-of-truth checks (do these before relying on the primitives)
- Confirm **CAP-0074/0075 are *Implemented* on testnet** and which `soroban-sdk` version exposes BN254/Poseidon host functions (the Stellar ZK *skill* text still says "proposed"; the newer Privacy/ZK *docs* say X-Ray shipped them — resolve against `/docs/networks/software-versions` and the `docs.rs/soroban-sdk` v25 migration pages).
- Confirm exact **Poseidon host-fn signatures** and the **`stellar-risc0-verifier` entrypoint** (journal/seal/image-id encoding) from the cloned repo.
- Confirm the **reserve asset** (testnet stablecoin → SAC contract id).
- **Testnet allows 1 contract tx/ledger** and resets periodically — pace the demo, don't rely on persistence.

## Rules of engagement
- Missing credential/account/RPC/asset → **stop and ask; don't stub or fake around it.**
- Live docs beat our appendix on conflict — note the discrepancy and proceed.
- Secrets never in code/logs/output; never commit `.env`.
- Small, phase-scoped commits; open-source from commit one; OSI license.
