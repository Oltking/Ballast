#!/usr/bin/env bash
# Run the Ballast contract tests in WSL (clean Linux toolchain).
set -e
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
cd /mnt/c/Users/USER/oltking-project/stellar/contracts
cargo test -p ballast-vault 2>&1 | tail -40
echo "WSL_CONTRACT_TEST_DONE"
