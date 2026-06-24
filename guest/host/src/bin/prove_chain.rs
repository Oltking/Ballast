//! Produce a **Groth16** solvency proof for on-chain verification (P3 real path).
//!
//! Proves the audit guest with `ProverOpts::groth16()` (STARK → Groth16 wrap via
//! the local Docker prover; needs Docker + RISC0_DEV_MODE=0), then emits the
//! three values the Ballast vault's `post_attestation` / the risc0 router need:
//!   line 1: journal      (raw 107-byte journal, hex)  -> pass to post_attestation
//!   line 2: seal         (encode_seal(receipt), hex)  -> pass to post_attestation
//!   line 3: image_id     (guest program id, hex)
//!   line 4: journal_digest (sha256(journal), hex)      -> sanity / direct router verify
//!
//! Public inputs are bound to the live vault by the caller (domain/reserves/
//! net_custodied/ratio/epoch). `L` is computed in-guest and never committed.
//!
//! Usage:
//!   cargo run -p ballast-host --release --bin prove_chain -- \
//!     --domain <HEX32> --reserves N --net-custodied N --epoch N [--ratio 10000] \
//!     [--balances 500000,300000] [--out proof_chain.txt]

use anyhow::{anyhow, Context, Result};
use ballast_core::{run_audit, Leaf, PublicInputs};
use ballast_methods::{BALLAST_AUDIT_ELF, BALLAST_AUDIT_ID};
use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
use sha2::{Digest as _, Sha256};
use std::fs;

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn hex32(s: &str) -> Result<[u8; 32]> {
    let v = hex::decode(s.trim_start_matches("0x")).context("domain hex")?;
    v.try_into().map_err(|_| anyhow!("domain must be 32 bytes"))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let domain = hex32(&arg(&args, "--domain").context("--domain <hex32> required")?)?;
    let reserves: u64 = arg(&args, "--reserves").context("--reserves required")?.parse()?;
    let net_custodied: u64 = arg(&args, "--net-custodied").context("--net-custodied required")?.parse()?;
    let epoch: u32 = arg(&args, "--epoch").context("--epoch required")?.parse()?;
    let ratio_bps: u32 = arg(&args, "--ratio").unwrap_or_else(|| "10000".into()).parse()?;
    let out = arg(&args, "--out").unwrap_or_else(|| "proof_chain.txt".into());

    // Optional private book; empty book => L = 0.
    let leaves: Vec<Leaf> = match arg(&args, "--balances") {
        None => Vec::new(),
        Some(list) if list.is_empty() => Vec::new(),
        Some(list) => list
            .split(',')
            .enumerate()
            .map(|(i, b)| {
                Ok(Leaf {
                    account: [i as u8; 32],
                    balance: b.trim().parse().context("balance")?,
                    salt: [(i as u8).wrapping_add(0xC0); 32],
                })
            })
            .collect::<Result<_>>()?,
    };

    let public = PublicInputs { reserves, net_custodied, ratio_bps, epoch, domain };
    let (outcome, l) = run_audit(&leaves, &public);
    eprintln!(
        "image id      : {}",
        Digest::from(BALLAST_AUDIT_ID)
    );
    eprintln!("L (private)   : {l}");
    eprintln!(
        "verdict       : solvent={} reserves_checked={} floor_checked={}",
        outcome.solvent, outcome.reserves_checked, outcome.floor_checked
    );
    eprintln!("proving Groth16 (this runs the Docker stark->snark wrap)…");

    let env = ExecutorEnv::builder()
        .write(&leaves)?
        .write(&public)?
        .build()?;
    let receipt = default_prover()
        .prove_with_opts(env, BALLAST_AUDIT_ELF, &ProverOpts::groth16())
        .context("groth16 proving failed (is Docker running and RISC0_DEV_MODE=0?)")?
        .receipt;

    receipt.verify(BALLAST_AUDIT_ID).context("receipt self-verify failed")?;

    let seal = encode_seal(&receipt).context("encode_seal failed")?;
    let journal = receipt.journal.bytes.to_vec();
    let journal_digest: [u8; 32] = Sha256::digest(&journal).into();
    let image_id: [u8; 32] = Digest::from(BALLAST_AUDIT_ID).as_bytes().try_into().unwrap();

    let body = format!(
        "{}\n{}\n{}\n{}\n",
        hex::encode(&journal),
        hex::encode(&seal),
        hex::encode(image_id),
        hex::encode(journal_digest),
    );
    fs::write(&out, &body).with_context(|| format!("write {out}"))?;
    eprintln!("journal bytes : {}", journal.len());
    eprintln!("seal bytes    : {}", seal.len());
    eprintln!("wrote {out} (journal / seal / image_id / journal_digest)");
    Ok(())
}
