//! Ballast solvency audit — RISC Zero guest program.
//!
//! Reads the private customer book + public inputs, builds the Poseidon→(SHA-256)
//! Merkle **sum** tree, checks `reserves >= ratio * L` and `L >= net_custodied`,
//! and commits the fixed-layout journal. The total liability `L` is computed but
//! **never committed** — only the root and the boolean verdict are public.

use ballast_core::{pack_journal, run_audit, Leaf, PublicInputs};
use risc0_zkvm::guest::env;

fn main() {
    let leaves: Vec<Leaf> = env::read();
    let public: PublicInputs = env::read();

    // `_l` is the private total liability — intentionally dropped, never committed.
    let (outcome, _l) = run_audit(&leaves, &public);

    let journal = pack_journal(&outcome, &public);
    env::commit_slice(&journal);
}
