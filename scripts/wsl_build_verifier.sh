#!/usr/bin/env bash
# Build the Nethermind stellar-risc0-verifier contracts to wasm (in WSL).
set -e
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
rustup target add wasm32v1-none >/dev/null 2>&1 || true
cd /mnt/c/Users/USER/oltking-project/stellar/research/github/stellar-risc0-verifier
echo "rustc: $(rustc --version)   stellar: $(stellar --version | head -1)"
stellar contract build
echo "=== wasm artifacts ==="
ls -la target/wasm32v1-none/release/*.wasm 2>/dev/null
echo "WSL_VERIFIER_BUILD_DONE"
