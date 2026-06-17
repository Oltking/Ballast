#!/usr/bin/env bash
# P2 smoke: ballast-core tests + build guest ELF + prove + verify (in WSL).
set -e
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$PATH"
cd /mnt/c/Users/USER/oltking-project/stellar/guest

echo "### rustc: $(rustc --version)   r0vm: $(r0vm --version 2>/dev/null)"
echo "### [1/2] ballast-core tests"
cargo test -p ballast-core

echo "### [2/2] ballast-host: build guest ELF + prove (real STARK, RISC0_DEV_MODE=0)"
RISC0_DEV_MODE=0 cargo run -p ballast-host --release
echo "P2_SMOKE_DONE"
