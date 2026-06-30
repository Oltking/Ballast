#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# passport_prove_submit.sh — produce a REAL Groth16 ZK Credit Passport proof
# and record it in the generic credential registry, in one command.
#
# Run on ANY x86_64 Linux host with Docker + the RISC Zero toolchain (the
# STARK->Groth16 wrap needs x86_64 + Docker; arm64 Macs can't).
#
# What it does:
#   1. builds the passport guest/host (CI's image id is baked in),
#   2. computes the issuer book's Merkle root (the predicate ANCHOR),
#   3. registers/rolls the predicate on-chain (pins image id + anchor) — admin,
#   4. proves one borrower's "good standing" predicate (Groth16),
#   5. submits the proof to the registry (records the credential),
#   6. reads back is_valid(subject, predicate).
#
# Env (falls back to .env, then defaults):
#   REGISTRY_ID         the credential registry contract id   (required)
#   REGISTRY_DOMAIN     32-byte registry domain, hex          (required)
#   SOURCE              signer: identity / G.../ raw S... secret. Defaults to
#                       SOURCE_ACCOUNT_SECRET from .env, else "ballast-admin".
#   PREDICATE_ID        registry predicate slot   (default 1)
#   THRESHOLD           min repaid loans to pass  (default 5)
#   SUBJECT_INDEX       which book record to prove (default 0 — the good one)
#   SUBJECT_HEX         optional: enrol a real wallet (hex32) as that borrower
#   FRESH_WINDOW        credential freshness ledgers (default 17280 ≈ 24h)
#   NONCE               anti-replay nonce; default = latest ledger (monotonic)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

set -a; [ -f .env ] && . ./.env; set +a

: "${STELLAR_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${STELLAR_NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"
REG="${REGISTRY_ID:?set REGISTRY_ID}"
DOMAIN="${REGISTRY_DOMAIN:?set REGISTRY_DOMAIN}"
SOURCE="${SOURCE:-${SOURCE_ACCOUNT_SECRET:-ballast-admin}}"
PREDICATE_ID="${PREDICATE_ID:-1}"
THRESHOLD="${THRESHOLD:-5}"
SUBJECT_INDEX="${SUBJECT_INDEX:-0}"
FRESH_WINDOW="${FRESH_WINDOW:-17280}"
OUT="$ROOT/proof_passport.txt"

export RISC0_DEV_MODE=0
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$HOME/.local/bin:$PATH"

NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---- 0. preflight -----------------------------------------------------------
bold "=== preflight ==="
case "$(uname -m)" in
  x86_64|amd64) : ;;
  *) die "This host is $(uname -m); the Groth16 wrap needs x86_64." ;;
esac
command -v cargo   >/dev/null || die "cargo not found."
command -v stellar >/dev/null || die "stellar CLI not found."
docker info >/dev/null 2>&1   || die "Docker daemon not reachable."
echo "host=$(uname -m) ok"

# Nonce: default to the latest ledger (strictly increases across runs).
if [ -z "${NONCE:-}" ]; then
  NONCE="$(curl -s "$STELLAR_RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
    | sed -n 's/.*"sequence":\([0-9]*\).*/\1/p')"
  [ -n "$NONCE" ] || die "couldn't read latest ledger for the nonce"
fi
echo "predicate=$PREDICATE_ID threshold=$THRESHOLD nonce=$NONCE subject_index=$SUBJECT_INDEX"

SUBJ_ARGS=(--subject-index "$SUBJECT_INDEX")
[ -n "${SUBJECT_HEX:-}" ] && SUBJ_ARGS+=(--subject-hex "$SUBJECT_HEX")

# Real issuer book from the backend, if configured (else the synthetic demo book).
BOOK_ARGS=()
if [ -n "${BACKEND_URL:-}" ] && [ -n "${PROVER_TOKEN:-}" ]; then
  bold "=== fetch real issuer book from $BACKEND_URL ==="
  curl -fsS "$BACKEND_URL/api/passport/leaves" -H "x-prover-token: $PROVER_TOKEN" \
    -o "$ROOT/passport_book.json" || die "could not fetch passport book"
  COUNT="$(grep -o '"subject"' "$ROOT/passport_book.json" | wc -l | tr -d ' ')"
  echo "fetched $COUNT borrower records"
  [ "$COUNT" -gt 0 ] || die "issuer book is empty — enrol a borrower first"
  BOOK_ARGS=(--book-json "$ROOT/passport_book.json")
fi

# ---- 1. build + read image id / anchor (dry-run) ---------------------------
bold "=== build + read image id / anchor ==="
cd "$ROOT/guest"
cargo build -p ballast-host --release --bin prove_passport
DRY="$(cargo run -q -p ballast-host --release --bin prove_passport -- \
  --domain "$DOMAIN" --predicate-id "$PREDICATE_ID" --nonce "$NONCE" \
  --threshold "$THRESHOLD" "${SUBJ_ARGS[@]}" "${BOOK_ARGS[@]}" --dry-run 2>/dev/null)"
IMAGE_ID="$(printf '%s\n' "$DRY" | sed -n 's/^IMAGE_ID=//p')"
ANCHOR="$(printf '%s\n' "$DRY" | sed -n 's/^ROOT=//p')"
SUBJECT="$(printf '%s\n' "$DRY" | sed -n 's/^SUBJECT=//p')"
cd "$ROOT"
[ -n "$IMAGE_ID" ] && [ -n "$ANCHOR" ] && [ -n "$SUBJECT" ] || die "dry-run did not yield image/anchor/subject"
echo "image_id=$IMAGE_ID"
echo "anchor=$ANCHOR"
echo "subject=$SUBJECT"

# ---- 2. register / roll the predicate (admin) ------------------------------
bold "=== register / roll predicate $PREDICATE_ID ==="
EXISTING="$(stellar contract invoke --id "$REG" --source "$SOURCE" "${NET[@]}" -- \
  predicate --predicate_id "$PREDICATE_ID" 2>/dev/null || true)"
if printf '%s' "$EXISTING" | grep -q "image_id"; then
  echo "predicate exists — set_predicate (re-pin image + anchor)"
  stellar contract invoke --id "$REG" --source "$SOURCE" "${NET[@]}" --send=yes -- \
    set_predicate --predicate_id "$PREDICATE_ID" --image_id "$IMAGE_ID" \
    --fresh_window "$FRESH_WINDOW" --anchor "$ANCHOR" --active true
else
  echo "predicate new — register_predicate"
  stellar contract invoke --id "$REG" --source "$SOURCE" "${NET[@]}" --send=yes -- \
    register_predicate --predicate_id "$PREDICATE_ID" --image_id "$IMAGE_ID" \
    --fresh_window "$FRESH_WINDOW" --label "ZK Credit Passport: good standing" \
    --anchor "$ANCHOR"
fi
sleep 8 # let the ledger close so submit reads a fresh sequence

# ---- 3. prove (Groth16) ----------------------------------------------------
bold "=== prove Groth16 (Docker stark->snark wrap) ==="
cd "$ROOT/guest"
cargo run -q -p ballast-host --release --bin prove_passport -- \
  --domain "$DOMAIN" --predicate-id "$PREDICATE_ID" --nonce "$NONCE" \
  --threshold "$THRESHOLD" "${SUBJ_ARGS[@]}" "${BOOK_ARGS[@]}" --out "$OUT"
cd "$ROOT"
[ -f "$OUT" ] || die "proof not produced"
JOURNAL="$(sed -n '1p' "$OUT")"
SEAL="$(sed -n '2p' "$OUT")"
[ -n "$JOURNAL" ] && [ -n "$SEAL" ] || die "journal/seal missing from $OUT"

# ---- 4. submit to the registry ---------------------------------------------
bold "=== submit to registry ==="
submit() {
  stellar contract invoke --id "$REG" --source "$SOURCE" "${NET[@]}" --send=yes -- \
    submit --journal "$JOURNAL" --seal "$SEAL"
}
submit || { echo "submit failed — retrying after a short delay…"; sleep 8; submit; }

# ---- 5. read back ----------------------------------------------------------
bold "=== read back ==="
echo -n "credential = "; stellar contract invoke --id "$REG" --source "$SOURCE" "${NET[@]}" -- \
  credential --subject "$SUBJECT" --predicate_id "$PREDICATE_ID" 2>/dev/null
echo -n "is_valid   = "; stellar contract invoke --id "$REG" --source "$SOURCE" "${NET[@]}" -- \
  is_valid --subject "$SUBJECT" --predicate_id "$PREDICATE_ID" --max_age 0 2>/dev/null
bold "PASSPORT_DONE — a real Groth16 credit-passport credential is recorded on-chain."
