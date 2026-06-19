//! `ballast-inclusion` — holder-side Merkle **sum**-tree inclusion tool (P5).
//!
//! The privacy-preserving customer check from the spec: a holder proves their
//! own leaf is committed under the published `liabilities_root` **without ever
//! sending the leaf on-chain**. All hashing goes through `ballast-core`, the
//! same crate the RISC Zero guest uses, so the holder check and the proof can
//! never drift.
//!
//! Subcommands:
//!   demo                          self-contained inclusion smoke (no files)
//!   prove  --book F --index N     emit an InclusionProof JSON for one leaf
//!   verify --proof F --root HEX   verify a proof against a published root
//!
//! A `book.json` is a JSON array of leaves:
//!   [{"account":[..32 bytes..],"balance":1000,"salt":[..32 bytes..]}, ...]

use ballast_core::{build_sum_tree, prove_inclusion, verify_inclusion, InclusionProof, Leaf};
use std::process::ExitCode;

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("demo") | None => demo(),
        Some("prove") => prove(&args),
        Some("verify") => verify(&args),
        Some(other) => {
            eprintln!("unknown subcommand: {other}\nusage: ballast-inclusion [demo|prove|verify]");
            ExitCode::FAILURE
        }
    }
}

fn load_book(path: &str) -> Result<Vec<Leaf>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse {path}: {e}"))
}

/// Self-contained smoke: build a book, publish the root, prove a holder's
/// inclusion, then show that a tampered claim is rejected.
fn demo() -> ExitCode {
    let book = vec![
        Leaf { account: [0xA1; 32], balance: 500_000, salt: [0x11; 32] },
        Leaf { account: [0xB2; 32], balance: 300_000, salt: [0x22; 32] },
        Leaf { account: [0xC3; 32], balance: 100_000, salt: [0x33; 32] }, // forces padding
    ];
    let (root, total) = build_sum_tree(&book);
    println!("book size           : {}", book.len());
    println!("published root      : {}", hex::encode(root));
    println!("total L (host-only) : {total}\n");

    let mut ok = true;
    for (i, _) in book.iter().enumerate() {
        let proof = prove_inclusion(&book, i).expect("index in range");
        let verified = verify_inclusion(&proof, &root);
        println!(
            "holder #{i} (balance {:>7}) inclusion: {}",
            book[i].balance,
            if verified { "VERIFIED" } else { "FAILED" }
        );
        ok &= verified;
    }

    // The lie: a holder claims a balance not in the committed book.
    let mut forged = prove_inclusion(&book, 1).unwrap();
    forged.leaf.balance += 1;
    let forged_ok = verify_inclusion(&forged, &root);
    println!("\nforged balance claim inclusion: {}", if forged_ok { "VERIFIED (BUG!)" } else { "REJECTED" });
    ok &= !forged_ok;

    if ok {
        println!("\nP5_INCLUSION_DEMO_OK");
        ExitCode::SUCCESS
    } else {
        eprintln!("\nP5_INCLUSION_DEMO_FAILED");
        ExitCode::FAILURE
    }
}

fn prove(args: &[String]) -> ExitCode {
    let book_path = match arg_value(args, "--book") {
        Some(p) => p,
        None => return fail("prove requires --book <file.json>"),
    };
    let index: usize = match arg_value(args, "--index").and_then(|s| s.parse().ok()) {
        Some(i) => i,
        None => return fail("prove requires --index <N>"),
    };
    let book = match load_book(&book_path) {
        Ok(b) => b,
        Err(e) => return fail(&e),
    };
    let (root, _) = build_sum_tree(&book);
    let proof = match prove_inclusion(&book, index) {
        Some(p) => p,
        None => return fail("index out of range for this book"),
    };
    // Emit the proof; the holder verifies it offline against the on-chain root.
    eprintln!("root: {}", hex::encode(root));
    println!("{}", serde_json::to_string_pretty(&proof).unwrap());
    ExitCode::SUCCESS
}

fn verify(args: &[String]) -> ExitCode {
    let proof_path = match arg_value(args, "--proof") {
        Some(p) => p,
        None => return fail("verify requires --proof <file.json>"),
    };
    let root_hex = match arg_value(args, "--root") {
        Some(r) => r,
        None => return fail("verify requires --root <hex>"),
    };
    let root_bytes = match hex::decode(root_hex.trim_start_matches("0x")) {
        Ok(b) if b.len() == 32 => b,
        _ => return fail("--root must be 32 bytes of hex"),
    };
    let mut root = [0u8; 32];
    root.copy_from_slice(&root_bytes);
    let raw = match std::fs::read_to_string(&proof_path) {
        Ok(s) => s,
        Err(e) => return fail(&format!("read {proof_path}: {e}")),
    };
    let proof: InclusionProof = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => return fail(&format!("parse {proof_path}: {e}")),
    };
    if verify_inclusion(&proof, &root) {
        println!("INCLUDED balance={} account={}", proof.leaf.balance, hex::encode(proof.leaf.account));
        ExitCode::SUCCESS
    } else {
        println!("NOT INCLUDED");
        ExitCode::FAILURE
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("error: {msg}");
    ExitCode::FAILURE
}
