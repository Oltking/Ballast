#!/usr/bin/env bash
# Build, deploy, initialize the Ballast vault on testnet, then run a P4
# enforcement smoke (read-only gate views + a live set_mode flip — no proof,
# no USDC needed). From WSL.
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
export RUST_MIN_STACK=33554432

ROOT=/mnt/c/Users/USER/oltking-project/stellar
ROUTER=CDLRCNMFXMNZIS3F4HCEGORXC4UM5XRAD7ZWBSWMDUAAZLRMVPQB2U4R
USDC_SAC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
IMAGE_ID=847c5e63c69a9daae262635168812aadc468c2783a5db9aa410749e0c94d5a6b
ADMIN=$(stellar keys address ballast-admin)

cd "$ROOT/contracts"
echo "=== build vault wasm ==="
stellar contract build --package ballast-vault >/tmp/vault_build.log 2>&1 || { tail -20 /tmp/vault_build.log; exit 1; }
WASM=$(ls target/wasm32v1-none/release/ballast_vault.wasm)
echo "wasm: $WASM ($(wc -c < "$WASM") bytes)"

echo "=== deploy vault ==="
VAULT_ID=$(stellar contract deploy --wasm "$WASM" --source ballast-admin --network testnet 2>/tmp/vault_deploy.log)
if [ -z "$VAULT_ID" ]; then tail -20 /tmp/vault_deploy.log; exit 1; fi
echo "VAULT_ID=$VAULT_ID"

# domain = the vault's own 32-byte contract id payload.
DOMAIN=$(python3 - "$VAULT_ID" <<'PY'
import base64, sys
s = sys.argv[1]
raw = base64.b32decode(s + "=" * ((8 - len(s) % 8) % 8))
print(raw[1:-2].hex())
PY
)
echo "DOMAIN=$DOMAIN"

echo "=== initialize (mode=0 AttestationOnly on-ramp) ==="
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- \
  initialize \
  --admin "$ADMIN" --operator "$ADMIN" \
  --reserve_token "$USDC_SAC" \
  --verifier "$ROUTER" \
  --image_id "$IMAGE_ID" \
  --mode 0 \
  --max_staleness_ledgers 17280 \
  --min_ratio_bps 10000 \
  --domain "$DOMAIN" 2>/tmp/vault_init.log || { tail -20 /tmp/vault_init.log; exit 1; }
echo "initialized."

echo "=== P4 smoke: enforcement views (AttestationOnly) ==="
echo -n "attestation_fresh = "; stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- attestation_fresh 2>/dev/null
echo -n "max_operator_withdrawable = "; stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- max_operator_withdrawable 2>/dev/null

echo "=== P4 smoke: flip to Enforced (admin) ==="
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- set_mode --mode 1 2>/tmp/vault_setmode.log || { tail -20 /tmp/vault_setmode.log; exit 1; }
echo -n "mode now = "; stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- config 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["mode"])' 2>/dev/null || echo "(see config)"
echo -n "attestation_fresh (Enforced, no proof) = "; stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- attestation_fresh 2>/dev/null
echo -n "max_operator_withdrawable (Enforced, no proof) = "; stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- max_operator_withdrawable 2>/dev/null

echo "=== restore to AttestationOnly on-ramp ==="
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- set_mode --mode 0 2>/dev/null
echo "VAULT_DEPLOY_DONE VAULT_ID=$VAULT_ID DOMAIN=$DOMAIN"
