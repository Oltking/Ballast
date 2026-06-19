#!/usr/bin/env bash
# P5 public re-verification: re-derive the vault's solvency state PURELY from
# chain reads (no server, no trust in the issuer). Anyone can run this.
#
# The contract already verified the Groth16 proof inside post_attestation before
# storing the attestation, so reading `latest_attestation` *is* the verification:
# the green state is the ledger's, not our word. We additionally re-confirm the
# attested public values still match live chain state.
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export XDG_CONFIG_HOME=/mnt/c/Users/USER/.config
export STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
export STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
V=${1:-CC2FR7RGP55JUI2NWZBYWSJOJ2WO3FCCXEL75VVSJBEHFEMWUZ32FY6N}

read_view() { stellar contract invoke --id "$V" --source ballast-admin --network testnet -- "$@" 2>/dev/null; }

echo "vault            : $V"
ATT=$(read_view latest_attestation)
echo "latest_attestation: $ATT"
echo "live reserves     : $(read_view reserves)"
echo "live net_custodied: $(read_view net_custodied)"
echo "epoch             : $(read_view epoch)"
echo "attestation_fresh : $(read_view attestation_fresh)"

if [ -z "$ATT" ] || [ "$ATT" = "null" ]; then
  echo "VERDICT: NO ATTESTATION ON CHAIN YET (post a real proof to populate)."
  exit 0
fi

python3 - "$ATT" "$(read_view reserves)" "$(read_view net_custodied)" <<'PY'
import sys, json
att = json.loads(sys.argv[1])
live_reserves = int(json.loads(sys.argv[2]))
live_nc = int(json.loads(sys.argv[3]))
solvent = att.get("solvent")
bound_reserves = int(att.get("reserves"))
bound_nc = int(att.get("net_custodied"))
reserves_ok = bound_reserves == live_reserves
nc_ok = bound_nc == live_nc
print(f"reserves bound==live : {reserves_ok} ({bound_reserves} vs {live_reserves})")
print(f"net_custodied bound==live: {nc_ok} ({bound_nc} vs {live_nc})")
verdict = "SOLVENT" if (solvent and reserves_ok and nc_ok) else "INSOLVENT / STALE"
print(f"VERDICT: {verdict}")
PY
echo "PUBLIC_VERIFY_DONE"
