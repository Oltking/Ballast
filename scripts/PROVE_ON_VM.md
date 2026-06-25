# Posting the first real attestation from a one-off x86_64 Linux VM

The Groth16 wrap needs **x86_64 Linux + Docker** (not the arm64 Mac). This is a
copy-paste runbook to spin up a throwaway VM, produce one real proof, post it,
and destroy the box. Budget ~30–40 min and a few cents.

> **Why a VM and not Render/Vercel/Bonsai?** PaaS platforms don't give your
> process a Docker daemon (the wrap needs it). Bonsai works from anywhere but
> needs an API key. A raw VM is the simplest no-account-signup path.

---

## 0. Provision the box

Any IaaS provider works. Pick an **x86_64 / amd64** image (NOT arm), Ubuntu
22.04 or 24.04, with **≥ 16 GB RAM (32 GB recommended)** and ~40 GB disk — the
`stark2snark` step is RAM-hungry.

- **DigitalOcean:** a 32 GB "General Purpose" / "Memory-Optimized" droplet (~$0.40–0.60/hr).
- **Hetzner Cloud:** `CPX41` (8 vCPU / 16 GB) or `CCX23` (16 GB) — cheapest.
- **AWS EC2:** `r6i.xlarge` (32 GB) or `m6i.2xlarge`. **Architecture: x86_64.**
- **GCP:** `e2-standard-8` (32 GB).

SSH in as **root** (simplest — avoids Docker group setup):

```bash
ssh root@<VM_IP>
```

---

## 1. Install the toolchain (run as root)

```bash
# system deps + docker
apt-get update
apt-get install -y build-essential git curl pkg-config libssl-dev docker.io
systemctl enable --now docker
docker run --rm hello-world          # sanity: should print "Hello from Docker!"

# rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# risc zero toolchain (installs r0vm + the groth16 prover support)
curl -L https://risczero.com/install | bash
export PATH="$HOME/.risc0/bin:$PATH"
rzup install

# stellar cli (compiles from source, ~5–10 min)
cargo install --locked stellar-cli
```

(If you'd rather not compile the CLI, grab a prebuilt `x86_64-unknown-linux-gnu`
binary from https://github.com/stellar/stellar-cli/releases and put it on PATH.)

---

## 2. Get the code + create `.env`

```bash
git clone https://github.com/Oltking/Ballast.git
cd Ballast
```

`.env` is **not** in the repo (it holds the secret). Create it on the VM —
paste your **own** operator/admin secret where shown; never commit it:

```bash
cat > .env <<'EOF'
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VAULT_CONTRACT_ID=CAWB5RDPTUSPQU4WSVWORKNBLHVCDQXRPPF7RYUR5UDVI6QMV6MWUD3I
VAULT_DOMAIN=2c1ec46f9d24f85396956ce8a9a159ea21c2f17bcbf8e291ed07547a0caf996a
SOURCE_ACCOUNT_SECRET=PASTE_YOUR_OPERATOR_SECRET_HERE
EOF
chmod 600 .env
```

> The `SOURCE_ACCOUNT_SECRET` is the funded admin/operator key (`GCPBZLNW…`).
> It's testnet-only, but still — that's why this is a **throwaway** box you
> destroy in step 4.

---

## 3. Prove + post (one command)

```bash
export RISC0_DEV_MODE=0
./scripts/prove_and_post.sh
```

What happens: it reads live `reserves`/`net_custodied`/`epoch`, proves the guest,
binds the journal to that state, posts `post_attestation(journal, seal)`, and
reads back the result. **First run pulls the Docker prover image** (a few min);
proving itself is a few min more.

Expected tail:

```
=== read back ===
epoch              = 1
status             = ...Healthy...
latest_attestation = ...solvent: true...
PROVE_AND_POST_DONE — the vault now holds a real, on-chain-verified Groth16 attestation.
```

The vault is now at **epoch 1** with a real attestation — your deployed frontend
(`Is my money safe?` / `My account` / operator console) immediately shows live
verified data.

### Optional: a meatier demo (non-trivial numbers)

Reserves/custodied are currently 0, so the default proof is a trivially-solvent
one. For real figures, **deposit some USDC first** (operator console in the app,
or `stellar contract invoke ... -- deposit`), then run with a private book that
sums to the new floor:

```bash
# e.g. after depositing 1000 USDC (net_custodied = 10_000_000_000 stroops):
BALANCES=6000000000,4000000000 ./scripts/prove_and_post.sh
```

(The balances are stroops and should sum to `net_custodied`; the script defaults
to a single leaf equal to the floor if you omit `BALANCES`.)

---

## 4. Tear down

```bash
exit                       # leave the VM
# then DESTROY the droplet/instance in your provider's console
```

Destroying the box removes the `.env` (and the secret) with it. Done — the proof
lives on-chain permanently; the machine was only needed to produce it.

---

## Troubleshooting

- **`Docker daemon not reachable`** — `systemctl start docker` (or you're not root / not in the `docker` group).
- **Killed / OOM during proving** — the box is too small; use ≥ 32 GB RAM.
- **`groth16 proving failed`** — ensure `RISC0_DEV_MODE=0` and Docker is running; the first pull can be slow on a thin network.
- **`DomainMismatch` / `EpochMismatch` / `ReservesMismatch`** — the journal didn't match live state; re-run (the script always reads fresh chain values, so this usually means the chain moved between read and post — just run it again).
- **`signer is not a known identity`** — set `SOURCE_ACCOUNT_SECRET` in `.env` (the script uses it directly).
