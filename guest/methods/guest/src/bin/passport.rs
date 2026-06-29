//! ZK Credit Passport — RISC Zero guest program (P-B).
//!
//! Reads a borrower's **private** credit record + its Merkle inclusion path, plus
//! public inputs (domain / predicate id / nonce / threshold / published root).
//! Proves the record is in the published set AND shows `repaid >= threshold` with
//! zero defaults, then commits the registry-shaped journal. The actual repayment
//! and default counts are **never committed** — only the subject, threshold, the
//! boolean verdict, and the root (anchor) are public.

use ballast_core::passport::{
    eval_passport, pack_passport_journal, CreditRecord, PassportInputs, PlainStep,
};
use risc0_zkvm::guest::env;

fn main() {
    let record: CreditRecord = env::read();
    let path: Vec<PlainStep> = env::read();
    let public: PassportInputs = env::read();

    let result = eval_passport(&record, &path, &public);

    let journal = pack_passport_journal(&record, &public, result);
    env::commit_slice(&journal);
}
