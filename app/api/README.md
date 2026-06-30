# Ballast custodian backend (serverless API)

The operator/custodian service that turns the simulated parts of Ballast into a
real product: it holds the **private per-user liabilities book** (balances +
salts) and the **credit-passport issuer records**, fulfils user **withdrawals**
on-chain with the operator key, and serves the **prover** the exact book it must
prove. The novel ZK (solvency enforced on-chain; credit passport verified
on-chain) was already real — this backend replaces the browser-side stand-ins
for the per-user book and withdrawals.

Runs as Vercel serverless functions in this `api/` directory (Node runtime).

## Provisioning (what you must set)

Set these as environment variables on the deployment (Vercel → Project →
Settings → Environment Variables). Nothing here is committed.

| Var | Purpose |
|---|---|
| `OPERATOR_SECRET` | Funded operator/admin `S…` key. Signs `withdraw_user` (and predicate management). **Server-only secret.** |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (add via Vercel → Storage → Upstash, one click). Also accepts `UPSTASH_REDIS_REST_URL` / `_TOKEN`. Without it the store is in-memory (non-durable). |
| `PROVER_TOKEN` | Shared secret gating `/api/book-leaves` and `/api/reconcile` (the prover/automation paths). Put the same value in the CI repo secrets. |
| `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `VAULT_CONTRACT_ID`, `REGISTRY_ID` | Optional overrides; sensible testnet defaults are baked in. |
| `ALLOW_ORIGIN` | Optional CORS origin lock (defaults to `*`). |

## Endpoints

Public:
- `GET /api/health` — store durability, operator configured, book stats.
- `GET /api/book` — published liabilities root, aggregate total L, count, live reserves/net_custodied.
- `GET /api/account?subject=<hex>` — minimal: is this subject counted, for how much.
- `GET /api/auth-challenge?address=G…` — one-time nonce to sign.

Wallet-auth'd (POST `{address, nonce, signature}` — sign the nonce with the wallet):
- `POST /api/account` — ensure account, reconcile your balance from on-chain custody, return your leaf (subject, balance, salt).
- `POST /api/inclusion` — your Merkle inclusion proof against the published root ("am I counted?").
- `POST /api/withdraw` — `{…, amount}`; operator fulfils `withdraw_user(to=you, amount)` on-chain.

Prover/automation (`x-prover-token: <PROVER_TOKEN>`):
- `POST /api/reconcile` — rebuild the book from on-chain custody (idempotent).
- `GET /api/book-leaves` — the full private book (ordered leaves) for the prover.

## Trust / security notes
- The operator key lives only on the server; users authorize redemptions with a
  wallet signature over a one-time challenge, and funds are always paid to the
  authenticated account.
- The book is reconciled to **on-chain custody** (`Σ deposits − Σ user-withdrawals`
  per address), so `L == net_custodied` and the solvency proof is honest. Adding
  accrued interest later only raises `L` above the floor.
- Individual leaves (balance + salt) are private to the operator; only the
  aggregate root + total are public.
