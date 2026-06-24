#!/usr/bin/env bash
# Build + run the Groth16 chain-prover in WSL (Docker daemon must be running).
set -e
export PATH="$HOME/.cargo/bin:$HOME/.risc0/bin:$PATH"
export RISC0_DEV_MODE=0
# Talk to the WSL-native dockerd we started.
export DOCKER_HOST=unix:///var/run/docker.sock

DOMAIN=${DOMAIN:-880a736a38e872f0535cd2698f98ee4f8b6c582bed238b377eecd5e50b5721c1}
RESERVES=${RESERVES:-0}
NC=${NC:-0}
EPOCH=${EPOCH:-1}
BAL=${BAL:-}

cd /mnt/c/Users/USER/oltking-project/stellar/guest
echo "=== build prove_chain ==="
cargo build --release -p ballast-host --bin prove_chain >/tmp/pc_build.log 2>&1 || { tail -25 /tmp/pc_build.log; exit 1; }

echo "=== prove (Groth16; first run pulls the docker prover image) ==="
ARGS="--domain $DOMAIN --reserves $RESERVES --net-custodied $NC --epoch $EPOCH --out /mnt/c/Users/USER/oltking-project/stellar/proof_chain.txt"
if [ -n "$BAL" ]; then ARGS="$ARGS --balances $BAL"; fi
./target/release/prove_chain $ARGS
echo "PROVE_CHAIN_DONE"
