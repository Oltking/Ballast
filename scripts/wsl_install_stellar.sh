#!/usr/bin/env bash
# Install the Linux stellar CLI into WSL (~/.local/bin), reusing the Windows
# stellar config (identities) via --config-dir at call time.
set -e
mkdir -p "$HOME/.local/bin"
cd /tmp
if [ ! -x "$HOME/.local/bin/stellar" ]; then
  URL="https://github.com/stellar/stellar-cli/releases/download/v26.1.0/stellar-cli-26.1.0-x86_64-unknown-linux-gnu.tar.gz"
  curl -sS -L --max-time 180 -o stellar-linux.tar.gz "$URL"
  tar -xzf stellar-linux.tar.gz
  install -m 0755 stellar "$HOME/.local/bin/stellar"
fi
export PATH="$HOME/.local/bin:$PATH"
echo "stellar (WSL): $(stellar --version | head -1)"
# Confirm we can read the Windows-side identity from WSL.
CFG=/mnt/c/Users/USER/.config/stellar
stellar keys address ballast-admin --config-dir "$CFG" 2>/dev/null && echo "shared identity OK" || echo "shared identity NOT reachable"
echo "WSL_STELLAR_DONE"
