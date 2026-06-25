#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# redeploy_vault.sh — redeploy the Ballast vault with a FRESH admin/operator key
# you control (used when the original deploy key is lost). Reuses the existing
# verifier router + USDC SAC. Builds + deploys from anywhere (arm64 is fine —
# only the RISC Zero *proving* needs x86_64).
#
# Prereqs: stellar CLI + Rust (cargo). Run from the repo root or scripts/.
#
# After it finishes it prints the new VAULT_ID / DOMAIN / ADMIN and writes them
# into .env. Then: add the new SOURCE_ACCOUNT_SECRET to GitHub secrets and run
# the prove-and-post workflow.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
export STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
export RUST_MIN_STACK=33554432

# Reused infra (unchanged from the original deployment).
ROUTER="${ROUTER:-CDLRCNMFXMNZIS3F4HCEGORXC4UM5XRAD7ZWBSWMDUAAZLRMVPQB2U4R}"
USDC_SAC="${USDC_SAC:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"
# image id to pin initially; the proving step (REPIN=1) re-pins to the build's id.
IMAGE_ID="${IMAGE_ID:-de044c9b0cca5ebefaa13ac9a9b6290131db3c123db344cbee4a6480e2c7dd27}"
IDENTITY="${IDENTITY:-ballast-admin}"
# Array (not a string) so the space-containing passphrase isn't word-split.
NET=(--rpc-url "$STELLAR_RPC_URL" --network-passphrase "$STELLAR_NETWORK_PASSPHRASE")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

bold "=== preflight ==="
command -v stellar >/dev/null || die "stellar CLI not found."
command -v cargo   >/dev/null || die "cargo not found — install Rust (rustup)."
echo "stellar=$(stellar --version | head -1)  cargo=$(cargo --version)"
# Ensure a 'testnet' network alias exists (used by keys generate/fund).
stellar network add testnet --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" >/dev/null 2>&1 || true

# ---- 1. fresh funded admin/operator identity --------------------------------
bold "=== identity '$IDENTITY' ==="
if stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  echo "reusing existing identity '$IDENTITY'"
else
  stellar keys generate "$IDENTITY" --network testnet --fund
  echo "generated + funded new identity '$IDENTITY'"
fi
ADMIN="$(stellar keys address "$IDENTITY")"
echo "ADMIN=$ADMIN"
# Make sure it's funded (idempotent).
stellar keys fund "$IDENTITY" --network testnet >/dev/null 2>&1 || true

# ---- 2. build vault wasm ----------------------------------------------------
bold "=== build vault wasm ==="
( cd "$ROOT/contracts" && stellar contract build --package ballast-vault )
WASM="$(ls "$ROOT"/contracts/target/wasm32v1-none/release/ballast_vault.wasm)"
echo "wasm: $WASM ($(wc -c < "$WASM") bytes)"

# ---- 3. deploy --------------------------------------------------------------
bold "=== deploy vault ==="
VAULT_ID="$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" "${NET[@]}")"
[ -n "$VAULT_ID" ] || die "deploy returned no contract id."
echo "VAULT_ID=$VAULT_ID"

# ---- 4. domain = the vault's own 32-byte contract-id payload ----------------
DOMAIN="$(python3 - "$VAULT_ID" <<'PY'
import base64, sys
s = sys.argv[1]
raw = base64.b32decode(s + "=" * ((8 - len(s) % 8) % 8))
print(raw[1:-2].hex())  # strip 1 version byte + 2 checksum bytes -> 32-byte payload
PY
)"
echo "DOMAIN=$DOMAIN"

# ---- 5. initialize ----------------------------------------------------------
bold "=== initialize (AttestationOnly, ratio 100%, staleness 17280) ==="
stellar contract invoke --id "$VAULT_ID" --source "$IDENTITY" "${NET[@]}" -- \
  initialize \
  --admin "$ADMIN" --operator "$ADMIN" \
  --reserve_token "$USDC_SAC" \
  --verifier "$ROUTER" \
  --image_id "$IMAGE_ID" \
  --mode 0 \
  --max_staleness_ledgers 17280 \
  --min_ratio_bps 10000 \
  --domain "$DOMAIN"
echo "initialized."

# ---- 6. smoke ---------------------------------------------------------------
bold "=== smoke ==="
echo -n "epoch         = "; stellar contract invoke --id "$VAULT_ID" --source "$IDENTITY" "${NET[@]}" -- epoch 2>/dev/null
echo -n "net_custodied = "; stellar contract invoke --id "$VAULT_ID" --source "$IDENTITY" "${NET[@]}" -- net_custodied 2>/dev/null

# ---- 7. persist to .env (never committed) -----------------------------------
bold "=== writing new ids to .env ==="
SECRET="$(stellar keys secret "$IDENTITY")"
touch .env
update_env() { # key value
  if grep -qE "^$1=" .env; then
    # portable in-place edit
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
update_env VAULT_CONTRACT_ID "$VAULT_ID"
update_env VAULT_DOMAIN "$DOMAIN"
update_env SOURCE_ACCOUNT_ADDRESS "$ADMIN"
update_env SOURCE_ACCOUNT_SECRET "$SECRET"
chmod 600 .env

bold "REDEPLOY_DONE"
echo "VAULT_ID = $VAULT_ID"
echo "DOMAIN   = $DOMAIN"
echo "ADMIN    = $ADMIN (admin == operator; secret stored in .env + stellar identity '$IDENTITY')"
echo
echo "Next: update app/src/lib/config.ts + the workflow with the new VAULT_ID/DOMAIN,"
echo "and add SOURCE_ACCOUNT_SECRET to GitHub repo secrets."
