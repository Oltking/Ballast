# Ballast — Deploy & Go-Live Runbook

A copy-paste runbook to take Ballast from "code committed" to "live, fully
functional" — the static frontend, the custodian backend, and the CI provers all
pointing at the same real book.

> Testnet only, research prototype. Never commit `.env` or any `S…` secret.

---

## 1. What you're turning on

You're standing up the **custodian backend** (`app/api/`, Vercel serverless
functions): it holds the **private per-user liabilities book** (balances + salts)
and the **credit-passport issuer records**, fulfils user **withdrawals** on-chain
with the operator key, and serves the **provers** the exact book they must prove.
The ZK itself was already real and on-chain; this backend replaces the
browser-side stand-ins for the per-user book and withdrawals. Once it's live, the
GitHub Actions provers pull the **real** book (instead of a synthetic one) and
post solvency / passport proofs that bind exactly what the backend publishes.

---

## 2. Provision (Vercel)

The repo deploys as a Vite SPA with the `app/` directory as the project root; the
`/api/*` serverless functions live alongside it, and `app/vercel.json` rewrites
every non-`/api` path back to the SPA.

1. **Import the repo** into Vercel and set **Root Directory = `app`**.
   (Framework auto-detects as Vite: build `npm run build`, output `dist`.)
2. **Add Upstash Redis** for the durable book: Vercel → **Storage** → create an
   Upstash Redis (KV) store and connect it to the project. This injects
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. Without it the store
   falls back to **in-memory** (non-durable — fine for a quick demo, but the book
   resets on every cold start).
3. **Add environment variables** (Settings → Environment Variables):

   | Var | Value | Notes |
   |---|---|---|
   | `OPERATOR_SECRET` | the funded operator/admin `S…` key | **Same key as `.env` `SOURCE_ACCOUNT_SECRET`.** Signs `withdraw_user`. **Server-only — never commit it, never expose it to the browser.** |
   | `PROVER_TOKEN` | any long random string | Gates `/api/reconcile`, `/api/book-leaves`, and the passport prover paths. Generate with `openssl rand -hex 32`. Put the **same value** in the CI repo secret (§3). |
   | `ADMIN_ADDRESS` | the operator/admin `G…` address | Optional. |
   | `ALLOW_ORIGIN` | your app origin, e.g. `https://ballast-gamma.vercel.app` | Optional CORS lock (defaults to `*`). |

   Sensible testnet defaults are baked in for `STELLAR_RPC_URL`,
   `STELLAR_NETWORK_PASSPHRASE`, `VAULT_CONTRACT_ID`, `REGISTRY_ID` — override only
   if you've redeployed contracts.
4. **Redeploy** so the new env + storage binding take effect (env changes don't
   apply to the running deployment until you redeploy).

---

## 3. Provision (GitHub Actions)

The provers (`.github/workflows/prove-and-post.yml`,
`.github/workflows/passport.yml`) pull the real book when `BACKEND_URL` +
`PROVER_TOKEN` are present; otherwise they fall back to a **synthetic** book.

In the repo → Settings → Secrets and variables → Actions:

- **Secret** `PROVER_TOKEN` — the **same value** you set in Vercel (§2).
- **Secret** `SOURCE_ACCOUNT_SECRET` — the funded operator `S…` key (the prover
  posts the attestation on-chain with it).
- **Variable** `BACKEND_URL` — the deployed app URL, e.g.
  `https://ballast-gamma.vercel.app` (no trailing slash).

With these set, each prover run calls `POST /api/reconcile` then
`GET /api/book-leaves`, rebuilds the exact sum-tree the backend published, and
posts a proof bound to it — so the on-chain attestation matches `/api/book`.

---

## 4. Verify

```bash
curl -fsS https://<app>/api/health | jq
```

Expect:

```json
{ "ok": true, "durableStore": true, "operatorConfigured": true, "proverTokenSet": true, ... }
```

- `durableStore: false` → Upstash not connected (§2.2).
- `operatorConfigured: false` → `OPERATOR_SECRET` missing/invalid (§2.3).
- `proverTokenSet: false` → `PROVER_TOKEN` missing (§2.3).

Then run the automated backend smoke test (checks every public surface; also
exercises the prover paths if you pass the token):

```bash
BASE_URL=https://<app> PROVER_TOKEN=<token> bash scripts/smoke_test.sh
```

---

## 5. Full end-to-end smoke (manual, with a wallet)

1. Open the deployed app → **My account** → connect **Freighter** (network:
   **Testnet**).
2. **Get testnet USDC**: one-click Friendbot XLM funding → wallet-signed
   `changeTrust` for the USDC SAC → Circle faucet hand-off.
3. **Deposit** USDC into the vault (you authorize it; `from.require_auth`).
4. **(Operator) reconcile** the book to on-chain custody: `POST /api/reconcile`
   with `x-prover-token` (the operator console does this, or run it via the smoke
   test / `curl`). The book now records your leaf at your net custody.
5. **Trigger the solvency prove workflow**: run `.github/workflows/prove-and-post.yml`
   (cron every 12h, or **Run workflow** manually). It pulls the real book via the
   backend and posts a Groth16 attestation. Proving takes **~20 min** on the free
   x86_64 CI runner.
6. **Confirm binding**: the vault's on-chain attestation `liabilities_root`
   equals the `liabilitiesRoot` from `GET /api/book`. (The trust page re-derives
   the SOLVENT verdict from chain reads alone.)
7. **"Am I counted?"**: in **My account**, run the client-side inclusion check —
   your leaf verifies against the published root (and the tamper toggle breaks
   it, as expected).
8. **Withdraw**: request a redemption — the backend has you sign a one-time
   challenge (`/api/auth-challenge`), then the operator fulfils
   `withdraw_user(to=you, amount)` on-chain with `OPERATOR_SECRET`.

The **passport** flow mirrors this via `.github/workflows/passport.yml` (enroll
records → prove → record on the registry), also ~20 min on free CI.

---

## 6. Security notes

- **Operator key is server-only.** `OPERATOR_SECRET` lives in Vercel env (and the
  CI secret as `SOURCE_ACCOUNT_SECRET`) — never in the client bundle, never
  logged, never committed.
- **Withdrawals require the user's wallet-signed challenge.** A redemption only
  proceeds after the authenticated account signs a one-time `/api/auth-challenge`
  nonce, and funds are always paid to that authenticated address.
- **The book can't over-state solvency.** It is reconciled to **on-chain custody**
  (`Σ deposits − Σ user-withdrawals` per address), so `L == net_custodied` and the
  solvency proof is honest; individual leaves (balance + salt) stay private to the
  operator — only the aggregate root + total are public.
