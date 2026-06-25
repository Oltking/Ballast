#!/usr/bin/env bash
# Post a real Groth16 attestation produced by prove_chain to the testnet vault,
# then read back the resulting state.
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

V=${1:-CAWB5RDPTUSPQU4WSVWORKNBLHVCDQXRPPF7RYUR5UDVI6QMV6MWUD3I}
PROOF=/mnt/c/Users/USER/oltking-project/stellar/proof_chain.txt

JOURNAL=$(sed -n '1p' "$PROOF")
SEAL=$(sed -n '2p' "$PROOF")
echo "journal bytes (hex chars): ${#JOURNAL}"
echo "seal bytes    (hex chars): ${#SEAL}"

echo "=== post_attestation ==="
stellar contract invoke --id "$V" --source ballast-admin --network testnet --send=yes -- \
  post_attestation --journal "$JOURNAL" --seal "$SEAL" 2>&1 | tail -6

echo "=== read back ==="
inv() { stellar contract invoke --id "$V" --source ballast-admin --network testnet -- "$@" 2>/dev/null; }
echo -n "epoch              = "; inv epoch
echo -n "status             = "; inv status
echo -n "latest_attestation = "; inv latest_attestation
echo -n "solvency_credential= "; inv solvency_credential
echo "POST_ATTESTATION_DONE"
