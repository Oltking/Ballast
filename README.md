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
| P3 | On-chain verification + attestation | ✅ **real Groth16 proof verified on-chain — vault at `epoch 1`, SOLVENT** (produced via the free GitHub Actions workflow) |
| P4 | Enforcement + staleness | ✅ **live in `Enforced` mode** — operator outflows gated on a fresh proof; auto-re-proved every 12h via CI |
| P5 | Inclusion + public re-verification | ✅ client-side inclusion + chain-only re-verify |
| P6 | Frontend (3 surfaces + tamper demo) | ✅ consumer-first redesign — trust page, customer dashboard (deposit/claim/verify/withdraw + on-chain activity + USDC onboarding), role-aware operator console |
| Features | F2 ratio · F3 credential/oracle · F4 margin feed · F5 breaker | ✅ contract + UI |
| P7–P10 | Hardening, polish | 🚧 a11y/responsive/loading polish, negative-path + auth tests, decoded errors, vendor-split bundle, free-CI proving pipeline done; audit pass next |

### Deployed (testnet)

| Contract | Address |
|---|---|
| Ballast vault | `CAULRHZ5WKYXHQJTF3BC3AV4QHOIEPDN5LIGDBWS6UOJ76YLLPT3VONR` |
| RISC Zero Groth16 verifier | `CCZ6SXH2FQ2CW3AIIUPHIKHXRJK5X55MTQS6P46MAPK7I6S4XIU6DOYF` |
| Reserve asset (USDC SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

The vault verifies proofs by calling Nethermind's [`stellar-risc0-verifier`](https://github.com/NethermindEth/stellar-risc0-verifier) Groth16 contract (`verify(seal, image_id, journal)`) — deployed **standalone** here (selector `73c457ba`, matching RISC Zero 3.0.x), not behind the shared router, so the verifier is fully under our admin key. Audit guest image id (current on-chain pin): `4711b310d51b710b9150d21b7dced6b9e8c566d45ce9b8e33047d87287b77bdf`, pinned via admin `set_image_id` to the CI (GitHub Actions) build.

**Live & self-maintaining.** The vault runs in **`Enforced`** mode (`min_ratio_bps=10000`, `max_staleness_ledgers=17280`) — operator outflows are gated on a fresh, solvent proof. The operator **auto-re-proves solvency every 12h** via the scheduled `Prove & post` GitHub Action, so the on-chain attestation stays fresh and tracks live reserves/liabilities. Real USDC is custodied and the public page reflects it.

**Enforcement (P4):** in `Enforced` mode, `withdraw_operator` is gated — it requires a solvency attestation that is *fresh* (within `max_staleness_ledgers`) and keeps `reserves_after ≥ net_custodied` (the on-chain custodied floor; `L` stays private, proven `L ≥ net_custodied`). Operator outflows never reduce `net_custodied`; user withdrawals are *never* gated. Admin can flip tiers via `set_mode`. Verified on testnet: flipping to `Enforced` with no fresh proof drives `max_operator_withdrawable` to 0.

**Features (F2–F5):**
- **F2 — over-collateralization ratio:** the guest proves `reserves ≥ ratio·L` for a configurable `min_ratio_bps` (100% = 1:1; higher = buffer); shown as "proven backing ≥ X%".
- **F3 — composable solvency credential + oracle:** a public `solvency_credential()` view, plus `require_fresh_attestation(max_age)` that other Soroban contracts call to gate their own logic — it traps against a stale/insolvent/wind-down custodian. The UI's "partner gate" mirrors this.
- **F4 — solvency-margin history feed:** a bounded on-chain ring buffer of recent attestations; the public page renders the `reserves − net_custodied` trend with a danger line at zero.
- **F5 — insolvency circuit-breaker + pro-rata exit:** an INSOLVENT proof (or, via `check_breaker`, a stale one in Enforced mode) trips the vault into `WindDown` — operator outflows hard-locked, while `withdraw_user` switches to pro-rata payouts (`amount · reserves / net_custodied`, ratio-preserving so there's no run advantage). A later solvent proof recovers to `Healthy`.

**Inclusion + public re-verification (P5):** a holder proves their own leaf is committed under the published `liabilities_root` entirely client-side, with the leaf never going on-chain — see `guest/tools` (`ballast-inclusion demo|prove|verify`), which uses the same `ballast-core` SHA-256 sum-tree as the guest. Anyone can re-derive the vault's SOLVENT/INSOLVENT verdict from chain reads alone via `scripts/wsl_public_verify.sh` (reads `latest_attestation` + live reserves/`net_custodied` and re-confirms the bound values). **A real attestation is live** — the vault is at `epoch 1`, SOLVENT, produced by the `Prove & post` GitHub Actions workflow (a real RISC Zero Groth16 proof, verified inside the Soroban contract).

## Repo layout

```
contracts/   Soroban: vault (+ policy + verifier integration), partner-gate oracle
guest/       RISC Zero zkVM audit program (Rust): core (sum-tree + inclusion), methods/guest, host, tools (ballast-inclusion CLI)
app/         React + Vite frontend: public verifier, holder inclusion, issuer dashboard
docs/        MASTER_SPEC, API_APPENDIX, FEATURES_ADDENDUM, FRONTEND_ATTACK_PLAN, build prompt
research/    harvested source-of-truth corpus (RESEARCH_FULL.md; cloned repos gitignored)
```

### Frontend (`app/`)

`npm install && npm run dev` in `app/`. Consumer-first design — a non-technical user should grasp "is my money safe?" in three seconds, with all jargon behind progressive disclosure. Deploys as a static client-side SPA (Vercel config in `app/vercel.json`; no backend, no build-time secrets — import the repo with **Root Directory `app`**). Three surfaces, all wired to the deployed testnet vault:
- **Is my money safe?** (public trust page) — a plain-language verdict ("Your money is fully backed."), a trust seal, a "% backed" bar, and a 3-step explainer, all re-derived purely from chain reads (no server). The technical depth — public/hidden split, `liabilities_root`, contract link, partner-gate — lives in a collapsible **"Verify it yourself"** drawer.
- **My account** (customer dashboard) — connect a Stellar wallet (your address *is* your leaf's account) and run the full customer lifecycle: a guided **Get testnet USDC** onboarding (one-click Friendbot XLM funding → wallet-signed `changeTrust` → Circle faucet hand-off), **deposit** USDC into the vault (real, you authorize it — `from.require_auth`), hold your **claim ticket** (the operator-issued leaf, with a private blinding salt — downloadable), **verify** you're counted (client-side inclusion + a tamper toggle, same `ballast-core` sum-tree) and that the provider is solvent (live chain reads), see your **activity** (deposits/withdrawals read straight from the Stellar event index — `getEvents` filtered on your address topic, so the timestamp is the real ledger close time and on-chain entries carry an `on-chain` badge), and **request a withdrawal** (redemptions are operator-orchestrated — `withdraw_user` needs operator auth — so a customer requests and the custodian fulfils). The per-user book is **simulated in the browser** (clearly labelled): on-chain there is only the aggregate `net_custodied`, so the operator's private-ledger bookkeeping is mocked locally while deposits, solvency and the activity feed are real chain interactions.
- **For operators** (issuer console) — **role-aware** (admin / operator / view-only chips derived from the vault config, with role-gated controls so unauthorized actions are flagged up front rather than reverting silently), the same **Get testnet USDC** onboarding for funding reserves, a live **reserves** panel (deposit / gated `withdraw_operator`, with a custodied-floor gauge), a **solvency-proof** panel (last verdict · fresh/stale · proof age vs the staleness window · proven vs policy ratio · Healthy/WindDown status), the **margin-history** chart (F4), an admin **`set_mode`** control (one-click Attest-only ⇄ Enforced), and a synthetic-book → journal preview with a "hide the whale" tamper toggle that forces the predicted verdict to INSOLVENT. In-browser proving is **not** wired (labeled WIP): the real STARK→Groth16 proof runs in the operator's prover service.

Polish baked in: light "financial-trust" design system, reduced-motion and keyboard-focus support, ARIA on interactive controls, responsive down to ~360px, a calm loading/skeleton + graceful network-error state on the trust page, decoded contract/trustline error messages, and a vendor-split bundle (Stellar SDK in its own cached chunk) so the UI paints fast.

## Confirmed environment facts ([corpus-verified])

- Testnet RPC `https://soroban-testnet.stellar.org` · passphrase `Test SDF Network ; September 2015` · Friendbot `https://friendbot.stellar.org`
- **CAP-0074 (BN254)** and **CAP-0075 (Poseidon/Poseidon2)** are **Final, shipped in Protocol 25 ("X-Ray")**. (The Stellar ZK *skill* text still says "proposed" — that wording is stale.)
- `stellar-risc0-verifier` interface: `verify(seal: Bytes, image_id: BytesN<32>, journal: BytesN<32>)` and `verify_integrity(receipt)`; a router dispatches by the 4-byte selector in the seal. `journal` is `sha256(journal_bytes)`; `seal = encode_seal(receipt)` (RISC Zero Groth16).
- Poseidon host fns are **low-level permutations** (`poseidon_permutation` / `poseidon2_permutation`, `field=1` for BN254 Fr); Ballast does **not** call them on-chain — hashing is in-guest and client-side.

## Current local state (honest WIP)

Development moved from Windows/WSL to an Apple-silicon (M1) Mac. The architecture is complete and verified end-to-end *off*-chain (guest builds and dev-mode-proves natively; the vault's `post_attestation` cryptographically verifies the Groth16 seal via the deployed Nethermind router, traps on a bad proof, and binds the journal to live chain values — audited). **The one remaining gap before the first real attestation lands on-chain (the vault is currently at `epoch 0`, `latest_attestation = null`) is producing the Groth16 seal:**

- **Groth16 wrap → any x86_64 Linux + Docker box (the only blocker).** RISC Zero's STARK→Groth16 wrap needs x86_64 Linux + Docker, impractical on arm64. This is a *hardware* limit, not a code one: the frontend (a static client-side SPA) never proves — proving is an off-chain operator job. Run it on **any x86_64 Linux host with Docker** (a cheap cloud VM, a Linux desktop, WSL, or a CI runner) and **no Bonsai is needed**; Bonsai is only the arm64 workaround. The whole flow is one command:

  ```bash
  # on an x86_64 Linux box with Docker + Rust + RISC Zero toolchain + stellar CLI:
  ./scripts/prove_and_post.sh
  ```

  It reads the live vault state, proves the guest, binds the journal to that state (domain / epoch+1 / reserves / net_custodied / ratio — the bindings `post_attestation` enforces), posts the seal with the operator key, and reads back the new `epoch`/`status`/`latest_attestation`. Heads-up: the snark wrap is RAM-hungry (~16 GB+). Do this **once** and the vault flips to `epoch 1` with a real, on-chain-verified attestation — after which the deployed frontend shows live verified data anywhere. **Step-by-step on a throwaway cloud VM: [`scripts/PROVE_ON_VM.md`](./scripts/PROVE_ON_VM.md).**
- **Admin/operator key.** ✅ Resolved by **redeploy.** The original deploy key was lost, so the vault was redeployed (`scripts/redeploy_vault.sh`) with a fresh admin/operator key we control (`GCPBZLNW…`, secret in `.env` + the `ballast-admin` Stellar CLI identity), reusing the same verifier router + USDC SAC. The current vault is **`CAULRHZ5WKYXHQJTF3BC3AV4QHOIEPDN5LIGDBWS6UOJ76YLLPT3VONR`** (see Deployed table). All admin/operator actions are now unblocked.
- **Guest image id.** ✅ The vault is pinned to `de044c9b…`; the proving step also runs with `REPIN=1`, so it admin-re-pins to whatever image the proving host builds — the proof always verifies regardless of build host.
- **Free way to produce the proof.** The repo ships a manual **GitHub Actions** workflow (`.github/workflows/prove-and-post.yml`) that runs the whole prove+post on a free x86_64 Linux runner — add the `SOURCE_ACCOUNT_SECRET` repo secret and click *Run workflow*. (16 GB runner may be tight; the 32 GB VM runbook above is the reliable fallback.)

## Open decisions (need owner input)

1. **Reserve asset:** which testnet stablecoin to wrap as the SAC reserve token (`RESERVE_ASSET`).
2. **Demo book size N** and whether to ship the auditor view-key mode in v1.

## License

[Apache-2.0](./LICENSE).
