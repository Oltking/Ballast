#!/usr/bin/env bash
# Verify set_mode persists on-chain (write tx), then restore.
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
V=CC2FR7RGP55JUI2NWZBYWSJOJ2WO3FCCXEL75VVSJBEHFEMWUZ32FY6N

mode() { stellar contract invoke --id "$V" --source ballast-admin --network testnet -- config 2>/dev/null | python3 -c 'import sys,json;print("mode =",json.load(sys.stdin)["mode"])'; }

echo "--- before ---"; mode
echo "--- set_mode 1 (Enforced) ---"
stellar contract invoke --id "$V" --source ballast-admin --network testnet --send=yes -- set_mode --mode 1 2>&1 | tail -3
echo "--- after flip ---"; mode
echo "--- set_mode 0 (restore AttestationOnly) ---"
stellar contract invoke --id "$V" --source ballast-admin --network testnet --send=yes -- set_mode --mode 0 2>&1 | tail -3
echo "--- restored ---"; mode
echo "P4_SETMODE_VERIFY_DONE"
