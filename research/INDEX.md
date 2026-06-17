# INDEX — Stellar Hacks: Real-World ZK / Ballast harvest

Harvested: 2026-06-17 (UTC). All content captured **verbatim** (raw HTML / raw PDF / git-source files). The only original writing in this research bundle is `INDEX.md`, `GAPS.md`, and `DEDUP.md`.

- Web/doc captures live under `docs/**` and `website/**`, each prefixed with a 3-line provenance header (`SOURCE` / `FETCHED` / `VERBATIM`).
- Cloned repos live under `github/<repo>/` (depth-1). Per-repo file listings are in `github/trees/<repo>.txt`. Repo files are verbatim git sources and are **not** individually header-stamped — their provenance is the clone URL below.
- `RESEARCH_FULL.md` concatenates every header-stamped web/doc capture for single-file review (repos excluded — they are large; browse them in `github/`).

Legend: status `200` = fetched OK; `405`/`522`/`ERR` = failed (see `GAPS.md`). Sizes are bytes on disk (including the 4-line header for web captures).

---

## A) Cloned repositories (verbatim git source — PRIORITY assets)

| Repo (clone URL) | Local path | Files | Why it matters for Ballast |
|---|---|---|---|
| https://github.com/NethermindEth/stellar-risc0-verifier | `github/stellar-risc0-verifier/` | 61 | **Our on-chain verifier.** Router + Groth16Verifier(BN254) + EmergencyStop + Timelock. Interface = `verify(seal,image_id,journal)` / `verify_integrity(receipt)`. |
| https://github.com/NethermindEth/stellar-private-payments | `github/stellar-private-payments/` | 252 | **Closest prior art / pool-vault + Poseidon-Merkle pattern.** `contracts/{pool,asp-membership,asp-non-membership,circom-groth16-verifier,soroban-utils,types}`, `circuits/`, `poseidon2/`, `app/` (client-side WASM proving), `docs/` (mdbook). Uses `soroban-sdk = 26`. |
| https://github.com/stellar/soroban-examples | `github/soroban-examples/` | 318 | Official examples incl. `groth16_verifier/`, **`privacy-pools/`** (circuits, `cli/`, `libs/lean-imt/` incremental Merkle tree), `import_ark_bn254/`. |
| https://github.com/jayz22/soroban-examples (branch `p25-preview`) | `github/jayz22-soroban-examples-p25/` | 268 | P25 preview BN254/Poseidon host-function examples referenced by the official ZK docs. |
| https://github.com/stellar/stellar-protocol | `github/stellar-protocol/` | 203 | CAPs: `core/cap-0059.md` (BLS12-381), `core/cap-0074.md` (BN254), `core/cap-0075.md` (Poseidon/Poseidon2). Also `ecosystem/sep-0056.md` (tokenized vault standard). |
| https://github.com/stellar/stellar-dev-skill | `github/stellar-dev-skill/` | 50 | Agent-ready skills incl. `skills/zk-proofs/SKILL.md` (+ soroban, dapp, assets, agentic-payments, data, standards). |
| https://github.com/OpenZeppelin/openzeppelin-skills | `github/openzeppelin-skills/` | 17 | Secure Soroban contract dev skills. |
| https://github.com/kaankacar/stellar-build | `github/stellar-build/` | 152 | 42-skill idea→mainnet journey. |
| https://github.com/yugocabrio/rs-soroban-ultrahonk | `github/rs-soroban-ultrahonk/` | 93 | Noir/UltraHonk Soroban verifier (reference / possible v2). |
| https://github.com/indextree/ultrahonk_soroban_contract | `github/ultrahonk_soroban_contract/` | 40 | Noir/UltraHonk Soroban verifier (referenced by official ZK docs). |
| https://github.com/stellar/ecosystem-resources | `github/ecosystem-resources/` | 50 | Ecosystem links. |
| https://github.com/lumenloop/stellar-ecosystem-db | `github/stellar-ecosystem-db/` | 769 | Ecosystem project DB (used for DEDUP). |
| https://github.com/briwylde08/stellar-hackathon-faq | `github/stellar-hackathon-faq/` | 1 | Hackathon FAQ (README only). |
| https://github.com/stellar/stellar-docs | `github/stellar-docs/` | 2828 | Full docs source (.mdx). Source of `docs/build/apps/{zk,privacy}.mdx`. |

## B) ZK & privacy core — web/doc captures

| Source URL | Local path | Status | Bytes |
|---|---|---|---|
| https://developers.stellar.org/llms.txt | `docs/stellar/llms.txt` | 200 | 14k |
| https://developers.stellar.org/docs/build/apps/zk | `docs/stellar/build-apps-zk.html` | 200 | 56k |
| github stellar-docs zk.mdx (source) | `docs/stellar/build-apps-zk.source.mdx` | 200 | 4k |
| https://developers.stellar.org/docs/build/apps/privacy | `docs/stellar/build-apps-privacy.html` | 200 | 59k |
| github stellar-docs privacy.mdx (source) | `docs/stellar/build-apps-privacy.source.mdx` | 200 | 7k |
| https://docs.rs/soroban-sdk/.../v25_bn254/index.html | `docs/stellar/soroban-sdk-v25_bn254.html` | 200 | 45k |
| https://docs.rs/soroban-sdk/.../v25_poseidon/index.html | `docs/stellar/soroban-sdk-v25_poseidon.html` | 200 | 34k |
| https://skills.stellar.org/skills/zk-proofs/SKILL.md | `docs/skills/zk-proofs-SKILL.md` | 200 | 7k |
| CAP-0074 / 0075 / 0059 | `github/stellar-protocol/core/cap-007{4,5}.md`, `cap-0059.md` | 200 | — |

## C) Verifiers & proving stacks — web/doc captures

| Source URL | Local path | Status | Bytes |
|---|---|---|---|
| https://stellar.org/blog/developers/risc-zero-verifier | `website/blog-risc-zero-verifier.html` | 200 | 168k |
| https://dev.risczero.com/api | `docs/risczero/dev-risczero-api.html` | 200 | 22k |
| https://dev.risczero.com/api/zkvm/ | `docs/risczero/zkvm-overview.html` | 200 | 27k |
| https://dev.risczero.com/api/zkvm/quickstart | `docs/risczero/zkvm-quickstart.html` | 200 | 39k |
| https://dev.risczero.com/api/zkvm/receipts | `docs/risczero/zkvm-receipts.html` | 200 | 27k |
| https://dev.risczero.com/terminology | `docs/risczero/terminology.html` | 200 | 45k |
| https://jamesbachini.com/stellar-risc-zero-games/ | `docs/risczero/jamesbachini-stellar-risc-zero-games.html` | 200 | 125k |
| https://nethermindeth.github.io/stellar-private-payments/ | `docs/stellar/private-payments-docs-site.html` | 200 | 82k |
| https://docs.circom.io/ | `docs/circom/circom-docs-home.html` | 200 | 41k |
| https://jamesbachini.com/circom-on-stellar/ | `docs/circom/jamesbachini-circom-on-stellar.html` | 200 | 117k |
| https://noir-lang.org/docs/ | `docs/noir/noir-docs-home.html` | 200 | 23k |
| https://jamesbachini.com/noir-on-stellar/ | `docs/noir/jamesbachini-noir-on-stellar.html` | 200 | 120k |

## C2) Confidential Tokens / Privacy Pools

| Source URL | Local path | Status | Bytes |
|---|---|---|---|
| https://www.confidentialtoken.org/ | `docs/confidential-tokens/confidentialtoken-org.html` | 200 | 33k |
| https://www.youtube.com/watch?v=6NnDqVQYOHM (CT demo page) | `docs/confidential-tokens/confidential-token-video-page.html` | 200 | 1.0M |
| Privacy Pools whitepaper (privacypools.com/whitepaper.pdf) | — | **FAILED** | see GAPS |

## D) Core Soroban build tooling — web/doc captures

| Source URL | Local path | Status | Bytes |
|---|---|---|---|
| https://developers.stellar.org/docs/tools/sdks | `docs/stellar/tools-sdks.html` | 200 | 53k |
| https://developers.stellar.org/docs/tools/cli | `docs/stellar/tools-cli.html` | 200 | 51k |
| https://developers.stellar.org/docs/tools/lab | `docs/stellar/tools-lab.html` | 200 | 58k |
| https://developers.stellar.org/docs/tools/quickstart | `docs/stellar/tools-quickstart.html` | 200 | 56k |
| https://developers.stellar.org/docs/build/smart-contracts/getting-started | `docs/stellar/getting-started.html` | 200 | 49k |
| https://developers.stellar.org/docs/build/guides/auth | `docs/stellar/guide-auth.html` | 200 | 53k |
| https://developers.stellar.org/docs/build/guides/storage | `docs/stellar/guide-storage.html` | 200 | 56k |
| https://developers.stellar.org/docs/build/guides/testing | `docs/stellar/guide-testing.html` | 200 | 59k |
| https://developers.stellar.org/docs/networks | `docs/stellar/networks.html` | 200 | 53k |
| https://scaffoldstellar.org/ | `website/scaffoldstellar-org.html` | 200 | 178k |
| https://stellarwalletskit.dev/ | `website/stellarwalletskit-dev.html` | 200 | 20k |
| https://www.openzeppelin.com/networks/stellar | `website/openzeppelin-networks-stellar.html` | 200 | 145k |
| https://skills.stellar.org/ | `website/skills-stellar-org.html` | 200 | 91k |

## E) Background / blogs

| Source URL | Local path | Status | Bytes |
|---|---|---|---|
| https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25 | `website/blog-x-ray-protocol-25.html` | 200 | 163k |
| https://stellar.org/blog/foundation-news/stellar-yardstick-protocol-26-upgrade-guide | `website/blog-yardstick-protocol-26.html` | 200 | 165k |
| https://stellar.org/blog/developers/financial-privacy | `website/blog-financial-privacy.html` | 200 | 215k |
| https://dorahacks.io/hackathon/stellar-hacks-zk/ | `website/dorahacks-stellar-hacks-zk.html` | **405** | 2.6k (block page) |

---

## VERIFICATION (required answers)

- **`llms.txt`**: fetched cleanly (200). It is an **index** of doc pages (navigation), not full content; listed pages were captured individually where in scope (tools, guides, getting-started, networks) — the priority ZK/privacy pages were captured both as rendered HTML and as `.mdx` git source. (Note: the Docusaurus `.md`-append trick does **not** work on this site — it returns the 404 search page; use rendered HTML or the `stellar-docs` repo source instead.)
- **Stellar Skills**: `zk-proofs/SKILL.md` fetched cleanly (200); full `stellar-dev-skill`, `openzeppelin-skills`, `stellar-build` repos cloned OK.
- **Testnet RPC URL**: `https://soroban-testnet.stellar.org`
- **Network passphrase**: Testnet = `Test SDF Network ; September 2015`; Mainnet = `Public Global Stellar Network ; September 2015`
- **Friendbot / Lab funding**: `https://friendbot.stellar.org` (testnet); Futurenet variant `https://friendbot-futurenet.stellar.org`; Lab funds testnet accounts at https://lab.stellar.org/.
- **`soroban-sdk` version**: `stellar-risc0-verifier` pins `25.1.0`; `stellar-private-payments` uses `26` (i.e. targets Protocol 26 / Yardstick BN254 host functions). Pick per target protocol.
- **`stellar` CLI**: install via `cargo install stellar-cli --locked` (docs do not pin a version — installs latest).
- **RISC Zero verifier interface** (`github/stellar-risc0-verifier/contracts/interface/src/lib.rs`):
  - `fn verify(env, seal: Bytes, image_id: BytesN<32>, journal: BytesN<32>) -> Result<(), VerifierError>` — convenience path (input hash all-zeros, exit code Halted(0), no assumptions).
  - `fn verify_integrity(env, receipt: Receipt) -> Result<(), VerifierError>` — full receipt; caller must pass correct `claim_digest` (use `ReceiptClaim::new(env, image_id, journal_digest).digest(env)`).
  - **Router** (`RiscZeroVerifierRouterInterface`) routes `verify()` by the **first 4 bytes (selector)** of the seal; helpers `verifiers(selector)`, `get_verifier_by_selector(selector)`, `get_verifier_from_seal(seal)`.
- **Proof/receipt format** (`docs/verifying-risc0-proofs.md`): host generates Groth16 with `ProverOpts::groth16()`; `seal = encode_seal(&receipt)` (from `risc0-ethereum-contracts ^3.0`, includes the 4-byte routing prefix); `image_id = methods::GUEST_PROGRAM_ID` (32 bytes); `journal_digest = sha256(receipt.journal)` (32 bytes). Groth16 proof generation needs Docker + **x86_64** (arm64 macOS must offload). STARK→SNARK Groth16 wrap requires `rzup install risc0-groth16`.
- **Continuations** (large books): RISC Zero zkVM splits long executions into segments (Continuations) — relevant if Ballast's customer book is large; see `docs/risczero/` captures + `dev.risczero.com`.
- **James Bachini tutorials** (one-liners): `stellar-risc-zero-games` = end-to-end RISC Zero zkVM → Soroban game (client proof → on-chain verify); `circom-on-stellar` = Circom/Groth16 circuit → Soroban groth16_verifier; `noir-on-stellar` = Noir/UltraHonk circuit → Soroban verifier.
- **DEDUP verdict**: see `DEDUP.md` — no existing Stellar/Soroban proof-of-solvency *reserve vault* found; Ballast's angle appears original. Closest infrastructure = `stellar-private-payments` (pool/ASP pattern, not solvency) and SEP-0056 (vault standard, no ZK solvency).
