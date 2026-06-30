//! Produce a **Groth16** ZK Credit Passport proof for on-chain verification (P-B).
//!
//! The issuer (lending protocol) holds a private set of borrower credit records
//! and publishes their Merkle **root** as the registry predicate's *anchor*. This
//! tool builds that set, proves one borrower's "good standing" predicate in the
//! `passport` guest (`repaid >= threshold`, zero defaults, record in the set),
//! wraps STARK→Groth16 (needs Docker + RISC0_DEV_MODE=0), and emits:
//!   line 1: journal   (raw 121-byte journal, hex)  -> registry `submit`
//!   line 2: seal      (encode_seal(receipt), hex)  -> registry `submit`
//!   line 3: image_id  (passport guest id, hex)     -> register_predicate
//!   line 4: root      (published anchor, hex)       -> register_predicate anchor
//!   line 5: subject   (the credentialed account, hex)
//!
//! `--dry-run` prints image_id / root / subject WITHOUT proving (fast; lets the
//! operator register/roll the predicate anchor before the slow proving step).
//!
//! Usage:
//!   cargo run -p ballast-host --release --bin prove_passport -- \
//!     --domain <HEX32> --predicate-id 1 --nonce 1 --threshold 5 \
//!     [--subject-index 0] [--subject-hex <HEX32>] [--dry-run] [--out proof_passport.txt]

use anyhow::{anyhow, Context, Result};
use ballast_core::passport::{
    build_credit_root, eval_passport, prove_credit_inclusion, CreditRecord, PassportInputs,
};
use ballast_methods::{PASSPORT_ELF, PASSPORT_ID};
use serde::Deserialize;
use risc0_ethereum_contracts::encode_seal;
use risc0_zkvm::sha::Digest;
use risc0_zkvm::{default_prover, ExecutorEnv, ProverOpts};
use sha2::{Digest as _, Sha256};
use std::fs;

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn hex32(s: &str) -> Result<[u8; 32]> {
    let v = hex::decode(s.trim_start_matches("0x")).context("hex32 decode")?;
    v.try_into().map_err(|_| anyhow!("expected 32 bytes"))
}

/// A small synthetic issuer book — used when no real book is provided. In
/// production the book comes from the lending protocol's private store
/// (`--book-json`, served by the backend); this keeps the demo reproducible.
fn demo_book() -> Vec<CreditRecord> {
    let mk = |tag: u8, repaid: u32, defaults: u32| CreditRecord {
        subject: [tag; 32],
        repaid,
        defaults,
        salt: [tag.wrapping_add(0x40); 32],
    };
    vec![
        mk(0x11, 12, 0), // good standing
        mk(0x22, 3, 2),  // has defaults
        mk(0x33, 30, 0), // excellent
        mk(0x44, 0, 0),  // brand new
    ]
}

/// One borrower record as served by the backend `/api/passport/leaves` (hex
/// subject/salt). Canonical order (backend sorts by subject), so the root the
/// prover builds matches the issuer's published anchor.
#[derive(Deserialize)]
struct RecordJson {
    subject: String,
    repaid: u32,
    defaults: u32,
    salt: String,
}

#[derive(Deserialize)]
struct BookJson {
    records: Vec<RecordJson>,
}

fn read_book_file(path: &str) -> Result<Vec<CreditRecord>> {
    let text = fs::read_to_string(path).with_context(|| format!("read book file {path}"))?;
    let recs: Vec<RecordJson> = match serde_json::from_str::<BookJson>(&text) {
        Ok(b) => b.records,
        Err(_) => serde_json::from_str::<Vec<RecordJson>>(&text).context("parse book json")?,
    };
    recs.into_iter()
        .map(|r| {
            Ok(CreditRecord {
                subject: hex32(&r.subject).context("record subject")?,
                repaid: r.repaid,
                defaults: r.defaults,
                salt: hex32(&r.salt).context("record salt")?,
            })
        })
        .collect()
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let domain = hex32(&arg(&args, "--domain").context("--domain <hex32> required")?)?;
    let predicate_id: u32 = arg(&args, "--predicate-id").unwrap_or_else(|| "1".into()).parse()?;
    let nonce: u32 = arg(&args, "--nonce").unwrap_or_else(|| "1".into()).parse()?;
    let threshold: u32 = arg(&args, "--threshold").unwrap_or_else(|| "5".into()).parse()?;
    let subject_index: usize = arg(&args, "--subject-index").unwrap_or_else(|| "0".into()).parse()?;
    let out = arg(&args, "--out").unwrap_or_else(|| "proof_passport.txt".into());
    let dry_run = args.iter().any(|a| a == "--dry-run");

    // The issuer book. Prefer the REAL book from `--book-json` (served by the
    // backend); else the synthetic demo book (optionally enrolling a real wallet
    // as the chosen good-standing borrower).
    let subject_hex = arg(&args, "--subject-hex");
    let (book, index) = match arg(&args, "--book-json") {
        Some(path) => {
            let book = read_book_file(&path)?;
            // Pick the record to prove: by --subject-hex if given, else index.
            let idx = if let Some(s) = &subject_hex {
                let want = hex32(s)?;
                book
                    .iter()
                    .position(|r| r.subject == want)
                    .ok_or_else(|| anyhow!("subject not enrolled in the issuer book"))?
            } else {
                subject_index
            };
            if idx >= book.len() {
                return Err(anyhow!("subject index out of range (book has {})", book.len()));
            }
            (book, idx)
        }
        None => {
            let mut book = demo_book();
            if subject_index >= book.len() {
                return Err(anyhow!("--subject-index out of range (book has {})", book.len()));
            }
            if let Some(s) = &subject_hex {
                book[subject_index].subject = hex32(s)?;
            }
            (book, subject_index)
        }
    };

    let root = build_credit_root(&book);
    let image_id: [u8; 32] = Digest::from(PASSPORT_ID).as_bytes().try_into().unwrap();
    let (record, path) = prove_credit_inclusion(&book, index)
        .ok_or_else(|| anyhow!("inclusion proof build failed"))?;

    eprintln!("image id   : {}", hex::encode(image_id));
    eprintln!("root(anchor): {}", hex::encode(root));
    eprintln!("subject     : {}", hex::encode(record.subject));
    eprintln!(
        "record      : repaid={} defaults={} (PRIVATE — never committed)",
        record.repaid, record.defaults
    );

    if dry_run {
        // Machine-readable lines for scripts.
        println!("IMAGE_ID={}", hex::encode(image_id));
        println!("ROOT={}", hex::encode(root));
        println!("SUBJECT={}", hex::encode(record.subject));
        return Ok(());
    }

    let public = PassportInputs { domain, predicate_id, nonce, threshold, root };
    let result = eval_passport(&record, &path, &public);
    eprintln!("verdict     : good_standing={result} (threshold={threshold})");
    if !result {
        return Err(anyhow!(
            "predicate is FALSE for this borrower/threshold — the registry would reject it"
        ));
    }
    eprintln!("proving Groth16 (Docker stark->snark wrap; needs RISC0_DEV_MODE=0)…");

    let env = ExecutorEnv::builder()
        .write(&record)?
        .write(&path)?
        .write(&public)?
        .build()?;
    let receipt = default_prover()
        .prove_with_opts(env, PASSPORT_ELF, &ProverOpts::groth16())
        .context("groth16 proving failed (is Docker running and RISC0_DEV_MODE=0?)")?
        .receipt;
    receipt.verify(PASSPORT_ID).context("receipt self-verify failed")?;

    let seal = encode_seal(&receipt).context("encode_seal failed")?;
    let journal = receipt.journal.bytes.to_vec();
    let journal_digest: [u8; 32] = Sha256::digest(&journal).into();

    let body = format!(
        "{}\n{}\n{}\n{}\n{}\n",
        hex::encode(&journal),
        hex::encode(&seal),
        hex::encode(image_id),
        hex::encode(root),
        hex::encode(record.subject),
    );
    fs::write(&out, &body).with_context(|| format!("write {out}"))?;
    eprintln!("journal bytes : {} (expect 121)", journal.len());
    eprintln!("seal bytes    : {}", seal.len());
    eprintln!("journal digest: {}", hex::encode(journal_digest));
    eprintln!("wrote {out} (journal / seal / image_id / root / subject)");
    Ok(())
}
