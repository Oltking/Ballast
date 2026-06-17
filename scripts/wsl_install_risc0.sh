#!/usr/bin/env bash
# Installs Rust + RISC Zero toolchain inside WSL Ubuntu. Idempotent-ish.
set -e
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$PATH"

echo "### [1/3] Rust (rustup)"
if ! command -v rustc >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
. "$HOME/.cargo/env"
rustc --version

echo "### [2/3] rzup (RISC Zero installer)"
if ! command -v rzup >/dev/null 2>&1; then
  curl -L https://risczero.com/install | bash
fi
export PATH="$HOME/.risc0/bin:$PATH"
rzup --version

echo "### [3/3] rzup install (rust toolchain + r0vm — large download)"
rzup install

echo "### versions"
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$PATH"
r0vm --version || echo "r0vm: not on PATH"
cargo risczero --version || echo "cargo-risczero: not on PATH"
echo "WSL_RISC0_INSTALL_DONE"
