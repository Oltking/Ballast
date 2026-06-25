#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# prove_and_post.sh — produce a REAL Groth16 solvency proof for the Ballast
# vault and post it on-chain, in one command.
#
# Run this on ANY x86_64 Linux host with Docker + the RISC Zero toolchain.
# (NOT arm64 / Apple silicon — RISC Zero's STARK->Groth16 wrap needs x86_64 +
# Docker. That hardware limit is the only reason this isn't run on the Mac.)
#
# It reads the live vault state from chain, proves the audit guest, binds the
# journal to that exact state (domain / epoch+1 / reserves / net_custodied /
# ratio — the bindings post_attestation enforces), then posts and reads back.
#
# Prereqs on the box:
#   - Rust toolchain (cargo) + the RISC Zero toolchain (rzup / r0vm)
#   - Docker daemon running (the snark wrap pulls a prover image)
#   - Stellar CLI (`stellar`) on PATH
#   - A funded operator identity (see SOURCE / SOURCE_ACCOUNT_SECRET below)
#
# Usage:
#   ./scripts/prove_and_post.sh
#   BALANCES=600000,400000 ./scripts/prove_and_post.sh   # custom private book
#
# Env (falls back to .env, then sensible defaults):
#   VAULT_CONTRACT_ID   target vault            (required)
#   VAULT_DOMAIN        32-byte domain, hex     (required — must match cfg.domain)
#   SOURCE              signer: an identity name, a G... public key, or a raw
#                       S... secret key. Defaults to SOURCE_ACCOUNT_SECRET from
#                       .env if set, else the identity name "ballast-admin".
#   RATIO               min ratio bps           (default 10000 = 100%)
#   BALANCES            comma-separated stroop balances = the private book.
#                       Defaults to a single leaf equal to net_custodied, which
#                       makes a SOLVENT proof bound to live state. Override to
#                       model a real multi-customer book (sum drives L).
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Load .env (secrets never echoed).
set -a; [ -f .env ] && . ./.env; set +a

: "${STELLAR_RPC_URL:=https://soroban-testnet.stellar.org}"
: "${STELLAR_NETWORK_PASSPHRASE:=Test SDF Network ; September 2015}"
VAULT="${VAULT_CONTRACT_ID:?set VAULT_CONTRACT_ID in .env}"
DOMAIN="${VAULT_DOMAIN:?set VAULT_DOMAIN in .env}"
RATIO="${RATIO:-10000}"
# Signer: prefer the secret from .env (works with no CLI setup; the v27 CLI
# accepts a raw S... secret directly as --source), else a named identity.
SOURCE="${SOURCE:-${SOURCE_ACCOUNT_SECRET:-ballast-admin}}"
OUT="$ROOT/proof_chain.txt"

export RISC0_DEV_MODE=0
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$HOME/.local/bin:$PATH"

NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---- 0. preflight -----------------------------------------------------------
bold "=== preflight ==="
case "$(uname -m)" in
  x86_64|amd64) : ;;
  *) die "This host is $(uname -m); the Groth16 wrap needs x86_64. Use an x86_64 Linux box." ;;
esac
command -v cargo   >/dev/null || die "cargo not found — install Rust + the RISC Zero toolchain."
command -v stellar >/dev/null || die "stellar CLI not found."
docker info >/dev/null 2>&1   || die "Docker daemon not reachable — start Docker (the snark wrap needs it)."
echo "host=$(uname -m) docker=ok cargo=ok stellar=ok"

# Resolve the signer: a raw S... secret is used directly; otherwise it must be a
# known identity (or a G... public key, for read-only use).
if [[ "$SOURCE" == S* && ${#SOURCE} -eq 56 ]]; then
  echo "signer: raw secret key (note: visible in this host's process list — use a dedicated box)"
elif stellar keys address "$SOURCE" >/dev/null 2>&1; then
  echo "signer: identity '$SOURCE'"
else
  die "signer '$SOURCE' is not a known identity. Either set SOURCE_ACCOUNT_SECRET in .env,
  set SOURCE to a raw secret key, or add the identity once:
    stellar keys add ballast-admin --secret-key   # paste the secret when prompted"
fi

# ---- 1. read live vault state ----------------------------------------------
bold "=== live vault state ($VAULT) ==="
view() { stellar contract invoke --id "$VAULT" --source "$SOURCE" "${NET[@]}" -- "$1" 2>/dev/null | tr -d '"[:space:]'; }
RESERVES="$(view reserves)"
NC="$(view net_custodied)"
EPOCH_NOW="$(view epoch)"
NEXT_EPOCH=$(( EPOCH_NOW + 1 ))
BALANCES="${BALANCES:-$NC}"   # default book: one leaf == net_custodied
echo "reserves=$RESERVES net_custodied=$NC epoch=$EPOCH_NOW -> proving epoch=$NEXT_EPOCH"
echo "domain=$DOMAIN ratio_bps=$RATIO book(balances)=[$BALANCES]"

# ---- 2. prove (Groth16) -----------------------------------------------------
bold "=== prove (Groth16 — first run pulls the docker prover image; needs RAM) ==="
( cd "$ROOT/guest" && cargo run --release -p ballast-host --bin prove_chain -- \
    --domain "$DOMAIN" --reserves "$RESERVES" --net-custodied "$NC" \
    --epoch "$NEXT_EPOCH" --ratio "$RATIO" --balances "$BALANCES" --out "$OUT" )

[ -s "$OUT" ] || die "prover produced no output ($OUT)."
JOURNAL="$(sed -n '1p' "$OUT")"
SEAL="$(sed -n '2p' "$OUT")"
IMAGE_ID="$(sed -n '3p' "$OUT")"
echo "journal hex chars=${#JOURNAL}  seal hex chars=${#SEAL}  image_id=$IMAGE_ID"

# ---- 2b. (optional) re-pin the vault to the freshly built image -------------
# RISC Zero image ids aren't reproducible across toolchains, so a proof built
# here may not match the deployed pin. With REPIN=1 (and an admin signer) we
# re-pin to this build's image id so the proof always verifies. No-op if it
# already matches. NOTE: if this changes the pin, update AUDIT_IMAGE_ID in
# app/src/lib/config.ts to $IMAGE_ID afterwards.
if [ "${REPIN:-0}" = "1" ]; then
  bold "=== set_image_id (admin re-pin to $IMAGE_ID) ==="
  stellar contract invoke --id "$VAULT" --source "$SOURCE" "${NET[@]}" --send=yes -- \
    set_image_id --image_id "$IMAGE_ID"
fi

# ---- 3. post on-chain -------------------------------------------------------
bold "=== post_attestation ==="
stellar contract invoke --id "$VAULT" --source "$SOURCE" "${NET[@]}" --send=yes -- \
  post_attestation --journal "$JOURNAL" --seal "$SEAL"

# ---- 4. read back -----------------------------------------------------------
bold "=== read back ==="
echo -n "epoch              = "; view epoch
echo -n "status             = "; stellar contract invoke --id "$VAULT" --source "$SOURCE" "${NET[@]}" -- status 2>/dev/null
echo -n "latest_attestation = "; stellar contract invoke --id "$VAULT" --source "$SOURCE" "${NET[@]}" -- latest_attestation 2>/dev/null
bold "PROVE_AND_POST_DONE — the vault now holds a real, on-chain-verified Groth16 attestation."
