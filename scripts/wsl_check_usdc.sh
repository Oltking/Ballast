#!/usr/bin/env bash
# Check the admin's USDC: classic (Horizon) + SAC (Soroban) balance.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ADMIN=GAKDJF75JLWEOGIUIHJLCZKL2IEHELKTVXOHD4L6AGHAQT4YZE4MWROT
USDC_SAC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

echo "=== classic balances (Horizon) ==="
curl -s "https://horizon-testnet.stellar.org/accounts/$ADMIN" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
for b in d.get("balances",[]):
    code=b.get("asset_code","XLM"); iss=b.get("asset_issuer","-")
    print(f"  {code:6} {b[\"balance\"]:>16}  issuer={iss}")' 2>/dev/null || echo "  (account fetch failed)"

echo "=== SAC balance (what the vault reads) ==="
stellar contract invoke --id "$USDC_SAC" --source ballast-admin --network testnet -- \
  balance --id "$ADMIN" 2>/dev/null
echo "CHECK_USDC_DONE"
