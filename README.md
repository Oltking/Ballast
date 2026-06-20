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

Phases (see `docs/PROMPT_2_build_STELLAR_ZK_v3.md`):

| Phase | What | State |
|---|---|---|
| P0 | Toolchain + testnet skeleton | ✅ verifier + vault deployed |
| P1 | Vault custody + flow accounting | ✅ |
| P2 | RISC Zero audit guest | ✅ real STARK proof end-to-end |
| P3 | On-chain verification + attestation | ✅ deployed + initialized on testnet |
| P4 | Enforcement + staleness | ✅ operator outflows gated; deployed on testnet |
| P5 | Inclusion + public re-verification | ✅ client-side inclusion + chain-only re-verify |
| P6 | Frontend (3 surfaces + tamper demo) | 🚧 public verifier, holder inclusion, issuer dashboard built |
| Features | F2 ratio · F3 credential/oracle · F4 margin feed · F5 breaker | ✅ contract + UI |
| P7–P10 | Hardening, polish | ⬜ |

### Deployed (testnet)

| Contract | Address |
|---|---|
| Ballast vault | `CCEAU43KHDUHF4CTLTJGTD4Y5ZHYW3CYFPWSHCZXP3WNLZILK4Q4DP65` |
| risc0-verifier router | `CDLRCNMFXMNZIS3F4HCEGORXC4UM5XRAD7ZWBSWMDUAAZLRMVPQB2U4R` |
| Router timelock | `CC6LR6L56FVVAFDABKHWP5EJP7S7CDUMA3SGXI4TAPPCWYCZYFJ6SU3J` |
| Reserve asset (USDC SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

Audit guest image id: `847c5e63c69a9daae262635168812aadc468c2783a5db9aa410749e0c94d5a6b`. Vault initialized in `AttestationOnly` mode (`min_ratio_bps=10000`, `max_staleness_ledgers=17280`).

**Enforcement (P4):** in `Enforced` mode, `withdraw_operator` is gated — it requires a solvency attestation that is *fresh* (within `max_staleness_ledgers`) and keeps `reserves_after ≥ net_custodied` (the on-chain custodied floor; `L` stays private, proven `L ≥ net_custodied`). Operator outflows never reduce `net_custodied`; user withdrawals are *never* gated. Admin can flip tiers via `set_mode`. Verified on testnet: flipping to `Enforced` with no fresh proof drives `max_operator_withdrawable` to 0.

**Features (F2–F5):**
- **F2 — over-collateralization ratio:** the guest proves `reserves ≥ ratio·L` for a configurable `min_ratio_bps` (100% = 1:1; higher = buffer); shown as "proven backing ≥ X%".
- **F3 — composable solvency credential + oracle:** a public `solvency_credential()` view, plus `require_fresh_attestation(max_age)` that other Soroban contracts call to gate their own logic — it traps against a stale/insolvent/wind-down custodian. The UI's "partner gate" mirrors this.
- **F4 — solvency-margin history feed:** a bounded on-chain ring buffer of recent attestations; the public page renders the `reserves − net_custodied` trend with a danger line at zero.
- **F5 — insolvency circuit-breaker + pro-rata exit:** an INSOLVENT proof (or, via `check_breaker`, a stale one in Enforced mode) trips the vault into `WindDown` — operator outflows hard-locked, while `withdraw_user` switches to pro-rata payouts (`amount · reserves / net_custodied`, ratio-preserving so there's no run advantage). A later solvent proof recovers to `Healthy`.

**Inclusion + public re-verification (P5):** a holder proves their own leaf is committed under the published `liabilities_root` entirely client-side, with the leaf never going on-chain — see `guest/tools` (`ballast-inclusion demo|prove|verify`), which uses the same `ballast-core` SHA-256 sum-tree as the guest. Anyone can re-derive the vault's SOLVENT/INSOLVENT verdict from chain reads alone via `scripts/wsl_public_verify.sh` (reads `latest_attestation` + live reserves/`net_custodied` and re-confirms the bound values). Populating a real attestation needs the Groth16 proving step below.

## Repo layout

```
contracts/   Soroban: vault (+ policy + verifier integration), partner-gate oracle
guest/       RISC Zero zkVM audit program (Rust): core (sum-tree + inclusion), methods/guest, host, tools (ballast-inclusion CLI)
app/         React + Vite frontend: public verifier, holder inclusion, issuer dashboard
docs/        MASTER_SPEC, API_APPENDIX, FEATURES_ADDENDUM, FRONTEND_ATTACK_PLAN, build prompt
research/    harvested source-of-truth corpus (RESEARCH_FULL.md; cloned repos gitignored)
```

### Frontend (`app/`)

`npm install && npm run dev` in `app/`. Three surfaces, all wired to the deployed testnet vault:
- **Public verifier** — re-derives SOLVENT / STALE / INSOLVENT purely from chain reads (no server); shows the public/hidden split and the `liabilities_root`.
- **Holder inclusion** — verifies your own leaf against the published root entirely in-browser (same SHA-256 sum-tree as `ballast-core`); leaf never leaves the device.
- **Issuer dashboard** — wallet-connected reserve panel (deposit / gated `withdraw_operator`) + a synthetic-book → journal preview with a "hide the whale" tamper toggle that forces the predicted verdict to INSOLVENT. In-browser proving is **not** wired (labeled WIP): the real STARK→Groth16 proof runs in the operator's prover service.

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
