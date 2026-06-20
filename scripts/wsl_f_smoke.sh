#!/usr/bin/env bash
# Smoke the F3/F4/F5 views on the deployed vault.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
V=${1:-CCEAU43KHDUHF4CTLTJGTD4Y5ZHYW3CYFPWSHCZXP3WNLZILK4Q4DP65}
inv() { stellar contract invoke --id "$V" --source ballast-admin --network testnet -- "$@" 2>/dev/null; }
echo -n "status                = "; inv status
echo -n "solvency_credential   = "; inv solvency_credential
echo -n "attestation_history   = "; inv attestation_history
echo -n "check_breaker         = "; inv check_breaker
echo "F_SMOKE_DONE V=$V"
