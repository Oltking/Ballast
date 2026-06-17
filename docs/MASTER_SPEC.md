# BALLAST — MASTER_SPEC.md

*A solvency-enforcing reserve vault for Stellar stablecoin custodians.*
Source of truth: `research/RESEARCH_FULL.md` (+ cloned repos under `github/`). Every Stellar/RISC Zero detail below is tagged either **[corpus-verified]** or **(confirm)** — confirm items must be checked against the live docs or the cloned repo before code relies on them.

---

## 1. What Ballast is

A custodian (neobank, payroll/remittance app, USDC-savings product) holds pooled stablecoin reserves in a Soroban **vault** and keeps a **private** internal per-user ledger. Ballast lets the custodian publish a periodic zero-knowledge proof that **reserves ≥ liabilities**, verified inside a Soroban contract, and **enforces** solvency by gating reserve outflows on a fresh proof. Anyone can re-verify the latest attestation from chain state alone; any user can privately confirm their balance is counted.

Tagline framing: *"the FTX-can't-happen-here vault."*

## 2. Why ZK is load-bearing (the defense in one sentence)

The alternatives are publishing every customer balance (a privacy/competitive catastrophe) or trusting a periodic auditor PDF (what FTX exploited). ZK is the only way to prove the aggregate inequality **and** per-user inclusion over a *hidden* book — and crucially it enforces **non-negativity + correct summation**, which plain hidden-Merkle proof-of-reserves cannot, closing the "insert a negative/fake balance to mask a shortfall" attack. Remove the ZK and the product cannot exist.

This is consistent with Stellar's own framing: the ZK host functions exist to enable **"compliance-forward, privacy-preserving applications"** [corpus-verified, ZK docs], and the Privacy docs name **payroll and institutional settlement** as target use cases [corpus-verified, Privacy docs].

## 3. Non-negotiables

1. **ZK load-bearing over a hidden book.** Never a variant where the liability set is public (that reduces solvency to public arithmetic — no ZK needed).
2. **Single-asset, on-chain custody = no oracle.** Reserves = the vault contract's own on-chain balance of one stablecoin, read in the same call. Multi-asset / off-chain reserves are explicitly OUT of the trustless core; any such extension is labelled a trust assumption.
3. **Bind the off-chain book to the chain.** The proof enforces `L ≥ net_custodied`, where `net_custodied` is maintained on-chain from vault deposits/outflows (omission-attack defense).
4. **Enforce, don't just attest.** Reserve outflows gated by a fresh proof; the vault reverts anything that would breach the last attested floor. Two tiers shipped: *attestation-only* and *enforced-vault*.
5. **`L` stays private.** Never written to the proof journal; only the liabilities root + boolean results are public.
6. **Trust-minimized proving.** RISC Zero (transparent STARK + one inherited, program-independent Groth16 ceremony) — no per-app Circom trusted setup. Verify the wrapped receipt on-chain via Nethermind's `stellar-risc0-verifier`.
7. **Defensive/legitimate only.** Solvency & compliance, not evasion. Never prompt users for seed phrases/keys.
8. **Verify every API against the corpus/live docs.** Never invent a host function, SDK signature, or verifier interface.

## 4. Threat model — what's eliminated vs. a stated assumption

| Risk | Status | Mechanism |
|---|---|---|
| Reserve oracle ("are reserves real?") | **Eliminated** | Reserves = vault's own on-chain balance, single asset, read in-call |
| Multi-asset valuation | **Eliminated (by scope)** | Single asset; multi-asset is a labelled v2 needing Reflector oracle |
| Omission attack (under-report liabilities) | **Eliminated** | Circuit enforces `L ≥ net_custodied`; `net_custodied` is on-chain |
| Snapshot gap (move funds after attesting) | **Eliminated (within staleness)** | Outflows gated by fresh proof; vault reverts breaches |
| Trusted setup forging proofs | **Reduced to inherited 1-time ceremony** | RISC Zero STARK + program-independent Groth16 wrap |
| "Green check looks like a signature" | **Solved at product surface** | Public re-verification, on-chain revert demo, tamper demo |
| Per-user completeness | **Stated assumption** | Only users who check inclusion are fully protected; closed by v2 |
| Interest accrual between attestations | **Stated, bounded** | Max-staleness window; guarantee = "reserves never below last attested floor" |
| Any off-chain reserves | **Stated assumption** | Out of trustless core; labelled in code + README |

## 5. Architecture — Verifier / Policy / Application split

Follows the Stellar ZK skill's recommended pattern (isolate cryptographic verification from business/compliance logic from state transition) [corpus-verified, ZK skill]:

- **Verifier** (crypto only): `stellar-risc0-verifier` — verifies the Groth16-wrapped RISC Zero receipt against the audit program's image ID. *(confirm interface against cloned repo)*
- **Policy** (business/compliance): the solvency checks — `reserves ≥ L`, `L ≥ net_custodied`, staleness/epoch, tier mode.
- **Application** (state transition): the **Vault** — custody, `net_custodied` accounting, attestation record, outflow gating, events.

```
Prover service (off-chain, operator infra)        On-chain (Soroban, testnet)
┌──────────────────────────────┐                  ┌───────────────────────────────┐
│ private customer book        │   receipt+journal│  Vault (Application+Policy)    │
│  → Poseidon Merkle sum tree  │ ───────────────▶ │   ├─ verify via risc0-verifier │
│  → RISC Zero guest (audit)   │                  │   ├─ check reserves ≥ L        │
│  → STARK → Groth16 wrap       │                  │   ├─ check L ≥ net_custodied   │
└──────────────────────────────┘                  │   ├─ check epoch+staleness     │
        ▲ liabilities_root (public)                │   ├─ record attestation, event │
        │                                          │   └─ gate operator outflows    │
  user holds (acct,bal,salt,path) ── verifies inclusion locally ──┘
```

## 6. Contracts

### 6.1 Vault (`contracts/vault`)
**Reserve asset:** a single stablecoin held as a Stellar Asset Contract (SAC) token. *(confirm: choose a testnet USDC-like asset and wrap as SAC per `/docs/build/guides/tokens`)* [corpus-verified that SAC is the mechanism].

**Storage (persistent):**
- `reserve_token: Address` (SAC contract id of the stablecoin)
- `admin/operator: Address`
- `net_custodied: i128` — running Σ(deposits) − Σ(all outflows)
- `epoch: u32` — increments per accepted attestation (anti-replay)
- `last_attested_liability: i128` (L*) and `last_attested_ledger: u32`
- `image_id: BytesN<32>` — the RISC Zero audit program's image ID (pinned) *(confirm format)*
- `mode: enum { AttestationOnly, Enforced }`
- `max_staleness_ledgers: u32`

**Functions:**
- `deposit(from, amount)` → pulls reserve token into vault, `net_custodied += amount`, event `deposit`.
- `withdraw_user(user, amount, …)` → user exit; `net_custodied -= amount`. **Always allowed** (never blocked by staleness — users can never be trapped).
- `withdraw_operator(amount)` → operator/fee/rehypothecation outflow. **Gated** (see §8). `net_custodied -= amount`.
- `post_attestation(journal, seal)` → §7/§8: verify receipt, enforce policy, bump epoch, record L*/ledger, event `attested`.
- `set_mode`, `set_max_staleness`, `set_image_id` → admin, guarded.
- Views: `reserves()` (reads SAC balance of self), `solvency_status()`, `latest_attestation()`.

**Reserves read:** `reserves = reserve_token.balance(vault_address)` — on-chain, in-call, no oracle.

### 6.2 Verifier integration
Call `stellar-risc0-verifier` with the receipt (journal + seal) and the pinned `image_id`. *(confirm exact entrypoint name + argument encoding against the cloned `NethermindEth/stellar-risc0-verifier`.)*

### 6.3 Inclusion (client-side, no contract needed for privacy)
A user verifies `Poseidon-Merkle(leaf, path) == liabilities_root` **locally** against the on-chain published root. No leaf is ever submitted on-chain. Optional: a stateless `verify_inclusion(root, leaf_commit, path)` view for convenience — but the canonical privacy-preserving check is client-side.

## 7. The RISC Zero audit guest program (`guest/`)

**Private inputs (witness):** the list of `(account_id, balance, salt)` leaves and tree structure.
**Public inputs / journal (what the verifier learns):**
- `liabilities_root: [u8;32]` (Poseidon Merkle **sum-tree** root)
- `reserves_checked: bool`, `floor_checked: bool`, `result: SOLVENT|INSOLVENT`
- `epoch: u32` (anti-replay binding), `domain: contract_id` (domain separation)
- **NOT** `L` (kept private)

**Constraints enforced inside the guest:**
1. Every `balance ≥ 0` (no negative balances to mask a shortfall).
2. The Poseidon Merkle **sum tree** is well-formed: each internal node = `Poseidon(left.hash, right.hash, left.sum + right.sum)`; root.hash == `liabilities_root`, root.sum == `L`.
3. `L ≥ net_custodied` (passed in as a public input bound to chain state).
4. `reserves ≥ L` (reserves passed as public input, bound to the vault's on-chain balance at attestation ledger).
5. `result = SOLVENT` iff (3) and (4) hold.

Because RISC Zero receipts are zero-knowledge, the verifier learns only the journal — nothing about individual balances or `L` [corpus-verified, RISC Zero security model]. Large books use **Continuations** (segmented proving) — *(confirm sizing; demo with bounded N, see §13)*.

**Why a Merkle *sum* tree (not plain Merkle):** it makes `Σ balances = L` provable without a separate O(N) summation gadget and lets per-user inclusion double as a partial-sum check.

## 8. Enforcement & staleness policy (DECIDED)

The vault stores `last_attested_liability` (L*), `last_attested_ledger`, and `max_staleness_ledgers`.

- **Fresh** = `current_ledger − last_attested_ledger ≤ max_staleness_ledgers`.
- **Operator outflow** (`withdraw_operator`) allowed iff: `mode == Enforced` ⇒ attestation is **Fresh** AND `reserves_after ≥ L*`. Otherwise **revert**.
- **Stale attestation** ⇒ operator outflows **blocked entirely** until a fresh attestation is posted. (Conservative lock — tightens only the operator.)
- **User withdrawals** (`withdraw_user`) are **never** blocked by staleness or solvency state. *Users can always exit.* This asymmetry is the whole point: the mechanism restricts the party that could misbehave, never the party being protected.
- `AttestationOnly` mode: records attestations and emits events but does not gate outflows (an on-ramp for operators not ready to lock the vault).

Default `max_staleness`: target ≈ 24h. *(confirm ledger-count: testnet ledger close ≈ 5s ⇒ ~17,280 ledgers; verify current close time.)*

Guarantee statement (exact, no overclaim): *"In Enforced mode, the operator can never withdraw reserves below the most recent attested liability floor, and that floor is never older than `max_staleness`."* Interest accrued between attestations is the bounded trust window.

## 9. Anti-replay / epoch binding

Per the ZK skill's "missing anti-replay controls" pitfall [corpus-verified], every proof commits to `{domain = vault contract_id, epoch}` in its journal. `post_attestation` accepts a proof only if `journal.domain == this contract` and `journal.epoch == stored epoch + 1`, then increments `epoch`. This prevents replaying an old "SOLVENT" proof and prevents cross-contract proof reuse.

## 10. Data model

- **Leaf:** `Poseidon(account_id, balance, salt)` with `sum = balance`. Salt gives per-leaf hiding so a guessable (account, balance) can't be brute-forced from the root.
- **Sum-tree node:** `{ hash = Poseidon(L.hash, R.hash, L.sum+R.sum), sum = L.sum+R.sum }`.
- **`net_custodied`:** integer maintained purely from on-chain vault flows. All value leaving the vault (user withdrawals **and** operator/fee draws) decrements it, keeping it a valid lower bound on liabilities.

## 11. Off-chain components

- **Prover service** (`guest/` host): runs in operator infra (book never leaves their environment); produces receipt + journal; submits `post_attestation`. Local `r0vm` or Bonsai *(confirm; Bonsai optional)*.
- **Frontend** (`app/`): Issuer dashboard (load book → prove → publish), Public verifier page (reads chain → green/red), Holder inclusion page (local check). Built with Stellar JS SDK + Wallets Kit; consider Scaffold Stellar to bootstrap [corpus-verified these tools exist].

## 12. Phased build order

Mirrors `docs/PROMPT_2_build_STELLAR_ZK_v2.md` P0–P6. Each phase ends with a smoke test proving real proofs flowing through a real testnet contract. (Verifier deploy in P0; vault+`net_custodied` P1; guest audit P2; on-chain verify+attest P3; enforcement+staleness P4; inclusion+public re-verify P5; frontend+tamper demo+README P6.)

## 13. Source-of-truth checks (REQUIRED before/while building)

1. **CAP status + SDK support** — confirm CAP-0074/0075 are *Implemented* on testnet and which `soroban-sdk` version exposes BN254/Poseidon host functions. (Skill text still says "proposed"; Privacy/ZK docs say shipped — resolve against `/docs/networks/software-versions` and `docs.rs/soroban-sdk` v25 migration pages.) [corpus flags this nuance]
2. **Poseidon host-fn signatures** — exact function names/arity from `soroban-sdk` v25_poseidon docs *(confirm; corpus captured the page but names not extracted here)*.
3. **`stellar-risc0-verifier` interface** — entrypoint, journal/seal/image-id encoding, from the cloned repo *(confirm)*.
4. **Reserve asset** — pick a testnet stablecoin, wrap as SAC, record its contract id *(confirm)*.
5. **Testnet limits** — **1 contract tx/ledger** on testnet [corpus-verified]; pace the demo accordingly; regular resets mean don't rely on persistence.
6. **Continuations sizing** — confirm max book size provable in one segment; pick demo N accordingly.
7. **v2 homomorphism** — Confidential Tokens are encryption-based and "in progress" on Stellar [corpus-verified]; do not assume additive-homomorphic commitment availability for the O(1) v2 until the standard lands.

## 14. v2 roadmap (forward-looking, not assumed)

- **O(1) homomorphic aggregate:** when a confidential-token-style additively-homomorphic on-chain liability aggregate is available, the contract maintains `Σ balances` by construction (closing per-user completeness with zero user vigilance). Depends on the Confidential Token standard landing on Stellar.
- **Selective disclosure / auditor view:** Privacy Pools on Stellar already describe **view keys** for authorized investigators [corpus-verified] — Ballast can expose an auditor mode that reveals the full book to a designated key while staying private to everyone else.
- **Compliance attestations:** the same Verifier/Policy split generalizes to reserve-composition limits, customer-concentration caps, correct yield distribution, Travel-Rule-compliant transfers.

## 15. Decisions resolved / still open

**Resolved:** proving stack (RISC Zero); target (single-asset stablecoin custodian); omission defense (`net_custodied` floor); snapshot defense (enforced vault); L privacy (journal omits L); enforcement/staleness policy (§8, operator-only restriction); anti-replay (epoch+domain).

**Still open (your call):** (a) which specific testnet stablecoin to use as the reserve asset; (b) demo book size N; (c) whether to ship the auditor view-key mode in v1 or defer to v2.
