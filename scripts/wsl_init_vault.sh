#!/usr/bin/env bash
# Initialize the already-deployed Ballast vault on testnet (mode passed as integer).
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

VAULT_ID=CDDP43KRSIGN7DBK22IK32LO5CEWQE4TYDVTVYPDYW65UNPDDZ3CPVOS
ROUTER=CDLRCNMFXMNZIS3F4HCEGORXC4UM5XRAD7ZWBSWMDUAAZLRMVPQB2U4R
USDC_SAC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
IMAGE_ID=847c5e63c69a9daae262635168812aadc468c2783a5db9aa410749e0c94d5a6b
DOMAIN=c6fe6d51920cdf8c2ad690ade96ee889681393c0eb3ae1e3c5bdda35e31e7627
ADMIN=$(stellar keys address ballast-admin)
echo "ADMIN=$ADMIN"

echo "=== initialize (mode=0 AttestationOnly) ==="
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- \
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

echo "=== smoke: config ==="
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- config
echo "=== smoke: net_custodied / epoch ==="
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- net_custodied
stellar contract invoke --id "$VAULT_ID" --source ballast-admin --network testnet -- epoch
echo "VAULT_INIT_DONE VAULT_ID=$VAULT_ID"
