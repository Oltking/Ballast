#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# prove_pool.sh — prove the LENDING POOL is solvent and post it on-chain.
#
# The pool is a provably-solvent vault whose assets = cash + outstanding loans.
# The SAME solvency guest proves `assets >= ratio·L >= ratio·pooled` over the
# private LENDER book, so lenders are provably covered without revealing
# positions. This reads `assets`/`pooled`/`epoch` from the pool, pulls the real
# lender book from the backend, proves, and posts to the pool contract.
#
# Run on x86_64 Linux + Docker (like prove_and_post.sh). Env (falls back to .env):
#   POOL_CONTRACT_ID   the pool contract           (required)
#   POOL_DOMAIN        32-byte pool domain, hex     (required)
#   SOURCE             signer (identity / G / raw S); default SOURCE_ACCOUNT_SECRET
#   BACKEND_URL + PROVER_TOKEN   pull the real lender book (else synthetic)
#   RATIO              min ratio bps (default 10000)
#   REPIN=1            admin re-pin the pool image id to this build
# ---------------------------------------------------------------------------
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
set -a; [ -f .env ] && . ./.env; set +a

: "${STELLAR_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${STELLAR_NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"
POOL="${POOL_CONTRACT_ID:?set POOL_CONTRACT_ID}"
DOMAIN="${POOL_DOMAIN:?set POOL_DOMAIN}"
RATIO="${RATIO:-10000}"
SOURCE="${SOURCE:-${SOURCE_ACCOUNT_SECRET:-ballast-admin}}"
OUT="$ROOT/proof_pool.txt"
export RISC0_DEV_MODE=0
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$HOME/.local/bin:$PATH"
NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

case "$(uname -m)" in x86_64|amd64) : ;; *) die "needs x86_64 (Groth16 wrap)"; esac
command -v stellar >/dev/null || die "stellar CLI not found."
docker info >/dev/null 2>&1 || die "Docker daemon not reachable."

bold "=== live pool state ($POOL) ==="
view() { stellar contract invoke --id "$POOL" --source "$SOURCE" "${NET[@]}" -- "$1" 2>/dev/null | tr -d '"[:space:]'; }
ASSETS="$(view assets)"     # cash + outstanding  (the pool's real backing)
POOLED="$(view pooled)"     # Σ lender claims floor
EPOCH_NOW="$(view epoch)"
NEXT_EPOCH=$(( EPOCH_NOW + 1 ))
echo "assets=$ASSETS pooled=$POOLED epoch=$EPOCH_NOW -> proving epoch=$NEXT_EPOCH"

PROVE_ARGS=()
if [ -n "${BACKEND_URL:-}" ] && [ -n "${PROVER_TOKEN:-}" ]; then
  bold "=== fetch real lender book from $BACKEND_URL ==="
  curl -fsS -X POST "$BACKEND_URL/api/pool?action=reconcile" -H "x-prover-token: $PROVER_TOKEN" >/dev/null \
    && echo "reconciled lender book"
  curl -fsS "$BACKEND_URL/api/pool?action=leaves" -H "x-prover-token: $PROVER_TOKEN" -o "$ROOT/pool_leaves.json" \
    || die "could not fetch pool leaves"
  echo "fetched $(grep -o '"account"' "$ROOT/pool_leaves.json" | wc -l | tr -d ' ') lender leaves"
  PROVE_ARGS=(--leaves "$ROOT/pool_leaves.json")
else
  BALANCES="${BALANCES:-$POOLED}"
  echo "no backend — synthetic book(balances)=[$BALANCES]"
  PROVE_ARGS=(--balances "$BALANCES")
fi

bold "=== prove (Groth16); reserves := assets = $ASSETS ==="
( cd "$ROOT/guest" && cargo run --release -p ballast-host --bin prove_chain -- \
    --domain "$DOMAIN" --reserves "$ASSETS" --net-custodied "$POOLED" \
    --epoch "$NEXT_EPOCH" --ratio "$RATIO" "${PROVE_ARGS[@]}" --out "$OUT" )
[ -s "$OUT" ] || die "prover produced no output"
JOURNAL="$(sed -n '1p' "$OUT")"; SEAL="$(sed -n '2p' "$OUT")"; IMAGE_ID="$(sed -n '3p' "$OUT")"

if [ "${REPIN:-0}" = "1" ]; then
  CFG="$(stellar contract invoke --id "$POOL" --source "$SOURCE" "${NET[@]}" -- config 2>/dev/null || true)"
  if printf '%s' "$CFG" | grep -q "$IMAGE_ID"; then
    echo "image already pinned — skipping set_image_id"
  else
    bold "=== set_image_id (re-pin pool to $IMAGE_ID) ==="
    stellar contract invoke --id "$POOL" --source "$SOURCE" "${NET[@]}" --send=yes -- set_image_id --image_id "$IMAGE_ID"
    sleep 8
  fi
fi

bold "=== post_attestation (pool) ==="
post() { stellar contract invoke --id "$POOL" --source "$SOURCE" "${NET[@]}" --send=yes -- post_attestation --journal "$JOURNAL" --seal "$SEAL"; }
post || { echo "retrying after delay…"; sleep 8; post; }

bold "=== read back ==="
echo -n "epoch    = "; view epoch
echo -n "credential = "; stellar contract invoke --id "$POOL" --source "$SOURCE" "${NET[@]}" -- solvency_credential 2>/dev/null
bold "PROVE_POOL_DONE — the lending pool holds a real on-chain solvency attestation (lenders provably covered)."
