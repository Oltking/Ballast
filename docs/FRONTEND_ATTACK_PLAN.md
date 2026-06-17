# BALLAST — FRONTEND_ATTACK_PLAN.md

The frontend exists to make the ZK and the *enforcement* **visible** — a green check is worthless if it looks like a trusted signature. Three surfaces + one scripted demo. **Before implementing any UI, load `/mnt/skills/public/frontend-design/SKILL.md`** and use its design tokens/constraints; the direction below is intent, not final tokens.

## Tech
- Stellar JS SDK + Stellar Wallets Kit for wallet connect and contract calls; RPC at `https://soroban-testnet.stellar.org`.
- Read attestations/credentials from the Vault via RPC; never reconstruct private data client-side beyond the user's own leaf.
- Proving runs in the operator's prover service (not the browser) for the off-chain-book design; the issuer dashboard calls that service, then submits `post_attestation`.

## Design direction
Trustworthy-instrument, not crypto-flashy. Think "audit dashboard you'd show a regulator": calm, high-contrast, legible numbers, one accent color for state (green = solvent/fresh, amber = stale, red = insolvent/wind-down). Monospace for hashes, ledgers, contract ids. Every claim on screen links to its on-chain source (tx hash / contract on `stellar.expert`). Make "what's public vs. what's hidden" explicit on every surface — that contrast *is* the product.

---

## Surface 1 — Issuer dashboard (operator)
**Job:** load book → prove → publish; manage reserves.
- Load a customer book (CSV/synthetic generator for the demo). Show count + a clear "this never leaves your environment / never goes on-chain" note.
- "Generate proof" → calls prover service → shows the **journal** that will be public (liabilities root, ratio, result, epoch) and explicitly lists what is **not** revealed (individual balances, `L`).
- "Publish attestation" → submits `post_attestation`; show tx hash + new epoch.
- Reserve panel: current on-chain reserves, `net_custodied`, margin, ratio; buttons for `deposit` and `withdraw_operator` (the latter will be gated — used in the demo to trigger a revert).

## Surface 2 — Public verifier (anyone)
**Job:** independent trust from chain state alone.
- Enter a vault contract id → show **SOLVENT / INSOLVENT**, **ratio backed** (F2), reserves, attested floor `L*`, epoch, **freshness** (fresh/amber-stale countdown).
- **Margin history feed** (F4): trend chart of `reserves − L*` and ratio across epochs — the "early-warning" view.
- "Re-verify from chain" button that re-reads the raw attestation so the user sees the green state isn't our word — it's the ledger's.
- Composability note (F3): show that `require_fresh_attestation` is callable by other contracts; ideally a tiny live "partner gate" widget that turns red when the custodian goes stale/insolvent.

## Surface 3 — Holder inclusion (customer)
**Job:** "is my balance counted?" — privately.
- User enters/loads their `(account, balance, salt, path)` (demo provides it).
- Verify `Poseidon-Merkle(leaf, path) == liabilities_root` **locally**; show ✓ included / ✗ not included. Emphasize the leaf never leaves the device.
- If wind-down (F5) is active, show the user's **pro-rata exit** and a `withdraw_user` action (which always works, even when the operator is locked).

---

## The tamper demo (the 3-minute closer)
Scripted, reproducible, on testnet:
1. **Healthy:** issuer publishes → public page shows SOLVENT, 105% backed (F2), margin trend climbing (F4); partner gate = green (F3).
2. **Enforcement:** issuer attempts `withdraw_operator` beyond the floor → **transaction reverts** on-chain (show the failed tx). A trusted signer could never refuse the operator — this is the contract doing it.
3. **The lie:** issuer hides a whale to fake solvency → `L ≥ net_custodied` fails (or the hidden user's inclusion check fails) → attestation returns **INSOLVENT**.
4. **The catch:** breaker trips → **wind-down** (F5); operator hard-locked; the hidden customer still **withdraws pro-rata**; partner gate flips **red** (F3). End on the public page showing the margin line crossing into the danger zone.

Every step shows the public/hidden split and links to the on-chain tx. The emotional payload: *"this is the exact lie FTX told — and the chain refuses it, while honest users still get their money."*

## Build order (frontend, within P5–P6)
1. Read-only Public verifier first (proves chain wiring) → 2. Holder inclusion (local Merkle check) → 3. Issuer dashboard (prove+publish) → 4. Margin feed + partner-gate widget → 5. Wire the full tamper script + record the demo video.
