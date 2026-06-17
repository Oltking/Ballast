//! Ballast prover host (P2 smoke).
//!
//! Demonstrates the off-chain proving flow: build a private book, prove the
//! audit in the RISC Zero zkVM, verify the receipt against the pinned image id,
//! and parse the public journal. Run inside WSL (where `r0vm` lives):
//!
//! ```text
//! cd guest && cargo run -p ballast-host --release
//! ```
//!
//! This is a STARK proof (no Groth16 wrap, no Docker) — that wrap is P3.

use anyhow::{Context, Result};
use ballast_core::{build_sum_tree, parse_journal, run_audit, Leaf, PublicInputs};
use ballast_methods::{BALLAST_AUDIT_ELF, BALLAST_AUDIT_ID};
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{default_prover, ExecutorEnv, Receipt};

fn leaf(account_tag: u8, balance: u64) -> Leaf {
    Leaf {
        account: [account_tag; 32],
        balance,
        salt: [account_tag.wrapping_add(0xA0); 32],
    }
}

/// A small synthetic customer book. L = 900_000 stroops.
fn demo_book() -> Vec<Leaf> {
    vec![
        leaf(1, 500_000),
        leaf(2, 300_000),
        leaf(3, 100_000),
    ]
}

fn prove(leaves: &[Leaf], public: &PublicInputs) -> Result<Receipt> {
    let env = ExecutorEnv::builder()
        .write(&leaves.to_vec())?
        .write(public)?
        .build()?;
    let receipt = default_prover()
        .prove(env, BALLAST_AUDIT_ELF)
        .context("proving failed")?
        .receipt;
    Ok(receipt)
}

fn main() -> Result<()> {
    println!("== Ballast P2 audit-guest smoke ==");
    println!("image id: {}", Digest::from(BALLAST_AUDIT_ID));

    // ---- Case 1: solvent book ----
    let book = demo_book();
    let public = PublicInputs {
        reserves: 1_000_000,
        net_custodied: 900_000,
        ratio_bps: 10_000, // 100%
        epoch: 1,
        domain: [7u8; 32],
    };
    let (expected, l) = run_audit(&book, &public);
    println!("\n[1] solvent book: local L = {l} (private), expect solvent=true");

    let receipt = prove(&book, &public)?;
    receipt
        .verify(BALLAST_AUDIT_ID)
        .context("receipt failed to verify")?;
    let j = parse_journal(&receipt.journal.bytes).context("bad journal layout")?;
    println!(
        "    receipt VERIFIES. journal: solvent={} reserves_checked={} floor_checked={}",
        j.solvent, j.reserves_checked, j.floor_checked
    );
    println!("    liabilities_root = {}", hex::encode(j.liabilities_root));
    assert_eq!(j.liabilities_root, expected.liabilities_root);
    assert!(j.solvent, "case 1 must be solvent");
    assert_eq!(receipt.journal.bytes.len(), ballast_core::JOURNAL_LEN);

    // ---- Case 2: insolvent book (reserves < L) — still a valid proof, of insolvency ----
    let public_bad = PublicInputs {
        reserves: 800_000, // < L
        ..public.clone()
    };
    let receipt2 = prove(&book, &public_bad)?;
    receipt2.verify(BALLAST_AUDIT_ID)?;
    let j2 = parse_journal(&receipt2.journal.bytes).unwrap();
    println!("\n[2] reserves<L: receipt VERIFIES, journal solvent={} (expect false)", j2.solvent);
    assert!(!j2.solvent, "case 2 must be insolvent");

    // ---- Case 3: tamper — altering one leaf changes the committed root ----
    let mut tampered = demo_book();
    tampered[0].balance += 1;
    let (root_orig, _) = build_sum_tree(&demo_book());
    let (root_tampered, _) = build_sum_tree(&tampered);
    println!("\n[3] tamper one leaf: root changes => {}", root_orig != root_tampered);
    assert_ne!(root_orig, root_tampered, "root must bind the exact book");

    println!("\nALL P2 CHECKS PASSED");
    Ok(())
}
