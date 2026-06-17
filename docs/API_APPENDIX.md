# BALLAST — API_APPENDIX.md

Verified interfaces for building Ballast. Tags: **[corpus-verified]** = found verbatim in `research/RESEARCH_FULL.md`; **(confirm)** = check against live docs or cloned repo before code relies on it. **Never invent an API.**

---

## 1. Network configuration (testnet) — [corpus-verified]

| Item | Value |
|---|---|
| Stellar RPC | `https://soroban-testnet.stellar.org` |
| Network passphrase | `Test SDF Network ; September 2015` |
| Network ID (SHA-256 of passphrase) | `cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Friendbot | `https://friendbot.stellar.org` (funds ~10,000 test XLM) |
| Smart-contract tx / ledger | **1** (testnet) — pace accordingly |
| Operations / ledger | 100 |
| Resets | periodic — do not rely on persistence of accounts/state |

Fund a testnet identity via Friendbot or the Lab (`https://lab.stellar.org`). For more accounts, fund one via Friendbot then use Create Account.

## 2. ZK host functions

### BN254 — CAP-0074 — [corpus-verified]
Adds host functions mirroring Ethereum's EIP-196/197 precompiles:
- `bn254_g1_add`
- `bn254_g1_mul`
- `bn254_multi_pairing_check`

Existing BN254-based circuits/tooling port without modification. Protocol 26 ("Yardstick") added nine more BN254 host functions (multi-scalar multiplication, scalar-field arithmetic, curve-membership) — *(confirm exact names/signatures in the Yardstick CAP + `docs.rs/soroban-sdk` v25/v26 migration pages.)*

### Poseidon / Poseidon2 — CAP-0075 — [corpus-verified that they exist as host functions]
Hash functions designed for ZK circuits; "used for commitments, Merkle trees, and nullifiers," kept consistent between off-chain circuits and on-chain contracts. **Exact host-fn names/arity: (confirm)** against `docs.rs/soroban-sdk/.../_migrating/v25_poseidon/`. Ballast uses these for the Merkle **sum** tree node hash.

### BLS12-381 — CAP-0059 — [corpus-verified]
Pairing-friendly curve from an earlier protocol; available but not required by the RISC Zero/Groth16-on-BN254 path Ballast uses.

### Status nuance — [corpus-flagged]
The Stellar ZK *skill* text still labels BN254/Poseidon "proposed (CAP-0074/0075)"; the newer Privacy/ZK *docs* (updated Apr 2026) state X-Ray (Protocol 25) shipped them. **Required pre-flight:** verify CAP *Implemented* status + your `soroban-sdk` version's host-fn support on testnet via `/docs/networks/software-versions`. Capability-gate the ZK path; keep a clear failure if a primitive isn't available.

## 3. On-chain verifier — RISC Zero (Groth16)

- Repo: `NethermindEth/stellar-risc0-verifier` — [corpus-verified]; it is part of the **Stellar Private Payments** prototype and verifies Groth16-wrapped proofs from the RISC Zero zkVM (or Circom).
- Article: `https://stellar.org/blog/developers/risc-zero-verifier` — [corpus-verified].
- **Interface (confirm against cloned repo):** entrypoint name, and the encoding of `journal` (public outputs), `seal` (Groth16 proof bytes), and `image_id` (guest program identity). Ballast pins `image_id` in the vault and passes `{journal, seal}` to the verifier in `post_attestation`.
- RISC Zero properties relied on (confirm in `dev.risczero.com`): receipts are **zero-knowledge** (verifier learns only the journal); the STARK→Groth16 wrap uses a **one-time, program-independent** trusted setup (no per-app ceremony); **Continuations** handle large inputs by segmenting the proof.

## 4. Reserve asset via Stellar Asset Contract (SAC)
The reserve stablecoin is used as a Soroban-callable token through its **SAC** — [corpus-verified that SAC is the mechanism]. The vault reads `reserve_token.balance(vault_address)` for live reserves and uses `transfer` for deposits/withdrawals. Guides: `/docs/build/guides/tokens` (SAC Tokens), `/docs/tokens/stellar-asset-contract`, `/docs/tokens/token-interface`. **(confirm)** the testnet stablecoin to use and its SAC contract id.

## 5. Contract surface (Ballast)
See `MASTER_SPEC.md` §6 for full storage/functions. Summary:
- **Vault:** `deposit`, `withdraw_user` (always allowed), `withdraw_operator` (gated), `post_attestation(journal, seal)`, admin setters, views `reserves()`, `solvency_status()`, `latest_attestation()`.
- **Composable oracle (F3):** `require_fresh_attestation(max_age)` for other contracts to gate on.
- **Anti-replay:** every proof journal commits `{domain = vault contract_id, epoch}`; `post_attestation` requires `journal.epoch == stored_epoch + 1` and matching domain (per the ZK skill's anti-replay pitfall — [corpus-verified]).

## 6. Reference repos to study / reuse
- `NethermindEth/stellar-risc0-verifier` — our on-chain verifier. — [corpus-verified]
- `NethermindEth/stellar-private-payments` — closest prior art; **pool contract, Groth16 verifier, ASP membership + non-membership (sparse Merkle) contracts**, client-side WASM proving. Reuse the Poseidon-Merkle and (for F6) ASP non-membership patterns. — [corpus-verified]
- `stellar/soroban-examples` → `groth16_verifier` — reference verifier + general examples. — [corpus-verified]
- `jayz22/soroban-examples` `p25-preview` — Protocol 25 ZK host-function usage examples. (from harvest)

## 7. Tooling — [corpus-verified these exist]
- **Stellar CLI** (`/docs/tools/cli`) — build/deploy/invoke Soroban contracts.
- **Lab** (`https://lab.stellar.org`, `/docs/tools/lab`) — generate + fund testnet accounts, explore txns.
- **Scaffold Stellar** (`/docs/tools/scaffold-stellar`) — app lifecycle bootstrap.
- **Stellar Wallets Kit** — unified wallet connection for the frontend.
- **OpenZeppelin on Stellar** — audited contracts, Wizard, Contracts MCP, Soroban security detectors. Run the detectors over Ballast's contracts.
- **Explorer** `https://stellar.expert` — show deployed contracts / txns in the demo.

## 8. SDK / build references
- SDKs index: `/docs/tools/sdks` (use latest for Protocol 26).
- `soroban-sdk` migration (host fns): `docs.rs/soroban-sdk/.../_migrating/v25_bn254/` and `.../v25_poseidon/`.
- Smart-contract guides used heavily: getting-started, auth (`__check_auth`), storage (persistent vs instance vs temporary + state archival/TTL — relevant to the bounded attestation-history ring buffer in F4), testing, events.
- `llms.txt`: `https://developers.stellar.org/llms.txt`.

## 9. Open (confirm) checklist
- [ ] CAP-0074/0075 *Implemented* on testnet; `soroban-sdk` version with host-fn support
- [ ] Poseidon host-fn exact names/arity
- [ ] `stellar-risc0-verifier` entrypoint + journal/seal/image_id encoding
- [ ] RISC Zero ZK-receipt + one-time-ceremony + Continuations specifics
- [ ] Testnet stablecoin + SAC contract id for `RESERVE_ASSET`
- [ ] Current testnet ledger close time → `max_staleness` in ledgers
- [ ] Resource/fee budget for an on-chain Groth16 verification (fees & metering)
