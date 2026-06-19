#!/usr/bin/env bash
# Deploy the risc0-verifier router (+ timelock) to testnet from WSL, reusing the
# Windows-side ballast-admin identity via XDG_CONFIG_HOME.
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config   # so `stellar` sees ballast-admin
VDIR=/mnt/c/Users/USER/oltking-project/stellar/research/github/stellar-risc0-verifier
cd "$VDIR"

# Normalize CRLF -> LF in all shell/python scripts (cloned on Windows).
find scripts -type f \( -name '*.sh' -o -name '*.py' \) -exec sed -i 's/\r$//' {} +
chmod +x scripts/manage.sh

echo "stellar: $(stellar --version | head -1)"
echo "deployer: $(stellar keys address ballast-admin)"
echo "=== deploy-router (timelock + router, min-delay 0) ==="
./scripts/manage.sh deploy-router -n testnet -a ballast-admin --min-delay 0
echo "=== status ==="
./scripts/manage.sh status -n testnet || true
echo "WSL_DEPLOY_ROUTER_DONE"
