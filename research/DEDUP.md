# DEDUP — prior-art check for Ballast

**Ballast** = a solvency-enforcing reserve vault for Stellar stablecoin custodians: prove in zero-knowledge, over a *private* customer book, that on-chain reserves ≥ liabilities, verified inside a Soroban contract (RISC Zero proving stack + Nethermind RISC Zero verifier).

**Question:** does anything in the Stellar/Soroban ecosystem already do proof-of-reserves / proof-of-solvency / a solvency-enforcing vault / ZK reserve attestation?

**Verdict: No direct competitor found. Ballast's angle appears original.** No project combines (a) ZK proof of (b) reserves ≥ liabilities over a (c) private customer book (d) enforced on-chain in a Soroban vault. The pieces Ballast needs exist as reusable infrastructure (RISC Zero verifier, privacy-pool/ASP patterns, a vault SEP), but nobody has assembled them into a custodian solvency proof.

Sources: `github/stellar-ecosystem-db/` (project DB, grepped), `github/stellar-protocol/ecosystem/sep-0056.md`, web search (DoraHacks/ScienceDirect/Stellar blog), and the cloned reference repos.

---

## Closest adjacent projects (and why each is NOT Ballast)

| Project | What it does | Distance from Ballast |
|---|---|---|
| **Alterscope** (`projects/alterscope.yaml`) | "Real-time risk processing and monitoring with zk-proofs to unlock **verifiable liquidity management** for protocol foundations, investors, retail." | **Closest in spirit.** But it's risk *monitoring/analytics* with ZK, not an on-chain vault that *enforces* reserves ≥ liabilities from a private book. No custodian solvency-proof contract. Worth watching / possible collaborator or competitor. |
| **Lumen Later** (`projects/lumen-later.yaml`) | Soroban BNPL lending with "real-time **solvency checks**", over-collateralized credit, liquidation. | "Solvency" here = borrower collateralization in a lending protocol, computed on public state. Not ZK, not custodian reserves, no private book. |
| **Nethermind — Stellar Private Payments (SPP)** + RISC Zero verifier (`projects/nethermind.yaml`; repos cloned) | Privacy-preserving payments (pool + ASP membership/non-membership), Groth16 verifier, RISC Zero on-chain verifier. | **The infrastructure Ballast builds on**, not a competitor. SPP proves payment validity/membership, not custodian solvency. Ballast reuses the pool-vault + Poseidon-Merkle + verifier patterns. |
| **soroban-examples / privacy-pools** (repo) | Reference privacy pool: circuits, CLI, incremental Merkle tree (`libs/lean-imt`). | Building block (Merkle commitments, nullifiers), not a solvency app. |
| **SEP-0056** (`stellar-protocol/ecosystem/sep-0056.md`) | Standard for **tokenized vault contracts** (deposit assets, mint vault tokens). | A vault *primitive/standard* with no ZK and no solvency proof. Ballast's vault could conform to it, but SEP-0056 alone proves nothing about reserves vs. liabilities. |
| **Boundless (boundlessxyz)** | Universal verifiable-compute layer using RISC Zero zkVM, proofs verified on-chain (Stellar/Ethereum). | Generic proving marketplace/infra; could *produce* Ballast's proofs but is not a solvency product. |
| **OpenZeppelin Fungible Token Vault** (search hit) | Audited Soroban vault (ERC-4626-style yield vault). | Vault mechanics only; no ZK, no solvency attestation. |

## The rest of the ZK field on Stellar (none overlap Ballast's domain)

- **ZK gaming**: Kalien (Asteroids), Warmancer, Arcane, James Bachini's RISC Zero games.
- **Private payments / confidential transfers**: Moonlight, Zarf, Sanctum (ZK+MPC), Stellot, Lumenshade, Confidential Token Association.
- **ZK identity / wallets**: Mimoto, Reclaim, Sollpay (keyless ZK wallet).
- **Verifiable data / scaling**: Space and Time, BTQ, Soundness, Fairblock, Socketfi.
- **Tooling / proving**: Noir (Aztec), RISC Zero, Nethermind.

## Whitespace Ballast occupies (un-built)

1. **ZK proof-of-solvency for a stablecoin *custodian*** (reserves ≥ liabilities), not borrower collateralization or payment privacy.
2. **Private customer *book* as the witness** — liabilities summed over a private liability set (Poseidon-Merkle commitment), only the aggregate inequality revealed.
3. **On-chain *enforcement*** — the Soroban vault gates actions (mint / withdraw / attestation) on a freshly verified RISC Zero solvency receipt, vs. off-chain periodic attestations (the Web2 PoR status quo; cf. BitGo/TheAccountantQuits articles found in search).
4. **RISC Zero zkVM path** (general Rust solvency logic in-guest) rather than a hand-written Circom/Noir circuit — lets the liability/reserve accounting be expressed as ordinary Rust, with Continuations for large books.

**Recommendation:** proceed — the angle is differentiated. De-risk by reaching out to / monitoring **Alterscope** (nearest ZK-liquidity overlap) and by building directly on **SPP** + **soroban-examples/privacy-pools** + the **Nethermind RISC Zero verifier**, optionally conforming the vault to **SEP-0056**.
