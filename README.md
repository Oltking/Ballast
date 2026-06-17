# Ballast

**A solvency-enforcing reserve vault for Stellar stablecoin custodians.**

> ⚠️ **Research prototype — not audited, testnet only.** Built for the "Stellar Hacks: Real-World ZK" hackathon.

A custodian holds pooled stablecoin reserves in a Soroban **vault** and keeps a *private* internal per-user ledger. Ballast proves in zero-knowledge that **reserves ≥ liabilities** without revealing the book, verifies the proof inside a Soroban contract, and **enforces** solvency by gating reserve outflows on a fresh proof. *"The FTX-can't-happen-here vault."*

- **Proving:** RISC Zero zkVM (audit guest in Rust) → STARK → Groth16 wrap. No per-app trusted setup.
- **On-chain verify:** Nethermind [`stellar-risc0-verifier`](https://github.com/NethermindEth/stellar-risc0-verifier) (Groth16 over BN254).
- **Commitments:** Poseidon Merkle **sum** tree (computed in-guest and client-side, not on-chain).
- **Custody:** single stablecoin held as a Stellar Asset Contract (SAC); reserves read on-chain in-call → **no oracle**.

See [`CLAUDE.md`](./CLAUDE.md) and [`docs/`](./docs) for the full spec. The harvested source-of-truth corpus is in [`research/RESEARCH_FULL.md`](./research/RESEARCH_FULL.md).

## Status

Early build. Phases (see `docs/PROMPT_2_build_STELLAR_ZK_v3.md`):

| Phase | What | State |
|---|---|---|
| P0 | Toolchain + testnet skeleton | 🚧 in progress |
| P1 | Vault custody + flow accounting | ⬜ |
| P2 | RISC Zero audit guest | ⬜ |
| P3 | On-chain verification + attestation | ⬜ |
| P4 | Enforcement + staleness | ⬜ |
| P5 | Inclusion + public re-verification | ⬜ |
| P6–P10 | Features, frontend, hardening | ⬜ |

## Repo layout

```
contracts/   Soroban: vault (+ policy + verifier integration), partner-gate oracle
guest/       RISC Zero zkVM audit program (Rust) + prover host/service
app/         issuer dashboard, public verifier page, holder inclusion page
docs/        MASTER_SPEC, API_APPENDIX, FEATURES_ADDENDUM, FRONTEND_ATTACK_PLAN, build prompt
research/    harvested source-of-truth corpus (RESEARCH_FULL.md; cloned repos gitignored)
```

## Confirmed environment facts ([corpus-verified])

- Testnet RPC `https://soroban-testnet.stellar.org` · passphrase `Test SDF Network ; September 2015` · Friendbot `https://friendbot.stellar.org`
- **CAP-0074 (BN254)** and **CAP-0075 (Poseidon/Poseidon2)** are **Final, shipped in Protocol 25 ("X-Ray")**. (The Stellar ZK *skill* text still says "proposed" — that wording is stale.)
- `stellar-risc0-verifier` interface: `verify(seal: Bytes, image_id: BytesN<32>, journal: BytesN<32>)` and `verify_integrity(receipt)`; a router dispatches by the 4-byte selector in the seal. `journal` is `sha256(journal_bytes)`; `seal = encode_seal(receipt)` (RISC Zero Groth16).
- Poseidon host fns are **low-level permutations** (`poseidon_permutation` / `poseidon2_permutation`, `field=1` for BN254 Fr); Ballast does **not** call them on-chain — hashing is in-guest and client-side.

## Open decisions (need owner input)

1. **Reserve asset:** which testnet stablecoin to wrap as the SAC reserve token (`RESERVE_ASSET`).
2. **Proving environment on Windows:** RISC Zero's Groth16 wrap needs Docker + x86_64 Linux. Options: WSL2 locally, or **Bonsai** remote proving (needs `BONSAI_API_KEY`). See `docs/` build notes.
3. **Demo book size N** and whether to ship the auditor view-key mode in v1.

## License

[Apache-2.0](./LICENSE).
