#!/usr/bin/env bash
# Deploy-router with clean logging (strip ANSI/spinner noise).
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export NO_COLOR=1 TERM=dumb
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
VDIR=/mnt/c/Users/USER/oltking-project/stellar/research/github/stellar-risc0-verifier
cd "$VDIR"
find scripts -type f \( -name '*.sh' -o -name '*.py' \) -exec sed -i 's/\r$//' {} +
chmod +x scripts/manage.sh

LOG=/tmp/deploy_router.log
./scripts/manage.sh deploy-router -n testnet -a ballast-admin --min-delay 0 >"$LOG" 2>&1
RC=$?
echo "=== exit code: $RC ==="
# strip ANSI escapes + spinner frames, drop empty lines, show the tail
sed -r 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r//g' "$LOG" \
  | grep -vE 'Building and optimizing|^[[:space:]]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][[:space:]]*$' \
  | grep -vE '^\s*$' \
  | tail -50
echo "WSL_DEPLOY_ROUTER2_DONE rc=$RC"
