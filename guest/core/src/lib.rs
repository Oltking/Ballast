//! Shared logic for the Ballast solvency audit, used by the RISC Zero guest
//! (proving) and the host (witness prep + journal parsing), and mirrored by the
//! client-side inclusion checker.
//!
//! **Hash: SHA-256.** The RISC Zero zkVM hardware-accelerates SHA-256, and the
//! on-chain contract never recomputes the hash (it trusts the verified journal),
//! so the only consistency requirement is guest(Rust) ↔ client(JS) — both use
//! standard SHA-256. Poseidon's circuit-friendliness buys nothing in a zkVM.
//!
//! Balance non-negativity (a non-negotiable: "no negative balance to mask a
//! shortfall") is enforced **structurally** by the `u64` balance type — a
//! negative liability cannot even be represented in the witness.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A private ledger entry. `account` is an opaque 32-byte id; `balance` is in
/// stroops (1e-7 units) of the reserve asset; `salt` hides the leaf preimage so
/// a guessable (account, balance) cannot be brute-forced from the root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Leaf {
    pub account: [u8; 32],
    pub balance: u64,
    pub salt: [u8; 32],
}

/// Public inputs supplied to the audit and echoed (bound) into the journal so
/// the on-chain contract can match them against live chain state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicInputs {
    /// On-chain reserves at attestation (vault's reserve-token balance), stroops.
    pub reserves: u64,
    /// On-chain `net_custodied` (Σ deposits − Σ outflows), stroops.
    pub net_custodied: u64,
    /// Minimum backing ratio in basis points; 10_000 = 100% (F2).
    pub ratio_bps: u32,
    /// Anti-replay epoch (must equal `vault.epoch + 1`).
    pub epoch: u32,
    /// Domain separation = vault contract id (32 bytes).
    pub domain: [u8; 32],
}

/// Result of the audit. `liabilities_root` commits to the exact book; the three
/// booleans are the public verdict. **`L` (the total) is never part of this.**
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditOutcome {
    pub liabilities_root: [u8; 32],
    pub reserves_checked: bool,
    pub floor_checked: bool,
    pub solvent: bool,
}

/// Decoded journal (host/contract side).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Journal {
    pub liabilities_root: [u8; 32],
    pub domain: [u8; 32],
    pub reserves: i128,
    pub net_custodied: i128,
    pub ratio_bps: u32,
    pub epoch: u32,
    pub reserves_checked: bool,
    pub floor_checked: bool,
    pub solvent: bool,
}

pub const EMPTY_HASH: [u8; 32] = [0u8; 32];
/// 32 root + 32 domain + 16 reserves + 16 net_custodied + 4 ratio + 4 epoch + 3 flags.
pub const JOURNAL_LEN: usize = 32 + 32 + 16 + 16 + 4 + 4 + 1 + 1 + 1;

/// `sha256(account || balance_be || salt)`.
pub fn hash_leaf(leaf: &Leaf) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(leaf.account);
    h.update(leaf.balance.to_be_bytes());
    h.update(leaf.salt);
    h.finalize().into()
}

/// Internal sum-tree node: `sha256(left_hash || right_hash || sum_be)`.
pub fn hash_node(left_hash: &[u8; 32], right_hash: &[u8; 32], sum: u128) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(left_hash);
    h.update(right_hash);
    h.update(sum.to_be_bytes());
    h.finalize().into()
}

/// Build a Merkle **sum** tree over the leaves (padded to a power of two with
/// empty `(hash=0, sum=0)` leaves). Returns `(root_hash, total_sum L)`.
/// Each node carries `sum = left.sum + right.sum`, so the root commits to both
/// the exact set of leaves *and* their total — making `Σ balances = L` provable
/// without a separate summation gadget.
pub fn build_sum_tree(leaves: &[Leaf]) -> ([u8; 32], u128) {
    if leaves.is_empty() {
        return (EMPTY_HASH, 0);
    }
    let mut level: Vec<([u8; 32], u128)> = leaves
        .iter()
        .map(|l| (hash_leaf(l), u128::from(l.balance)))
        .collect();
    while level.len() < level.len().next_power_of_two() {
        level.push((EMPTY_HASH, 0));
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            let (lh, ls) = pair[0];
            let (rh, rs) = pair[1];
            let sum = ls.checked_add(rs).expect("sum-tree total overflow");
            next.push((hash_node(&lh, &rh, sum), sum));
        }
        level = next;
    }
    level[0]
}

/// Run the solvency audit: compute the liabilities root + total `L`, then the
/// two predicates. Returns `(outcome, L)`; `L` is for host debugging only and
/// MUST NOT be committed to the journal.
pub fn run_audit(leaves: &[Leaf], pi: &PublicInputs) -> (AuditOutcome, u128) {
    let (liabilities_root, l) = build_sum_tree(leaves);
    let reserves = u128::from(pi.reserves);
    let nc = u128::from(pi.net_custodied);
    let ratio = u128::from(pi.ratio_bps);
    // reserves * 10_000 >= ratio_bps * L   (integer form of reserves >= ratio * L)
    let lhs = reserves.checked_mul(10_000).expect("reserves*bps overflow");
    let rhs = ratio.checked_mul(l).expect("ratio*L overflow");
    let reserves_checked = lhs >= rhs;
    let floor_checked = l >= nc;
    let solvent = reserves_checked && floor_checked;
    (
        AuditOutcome {
            liabilities_root,
            reserves_checked,
            floor_checked,
            solvent,
        },
        l,
    )
}

/// Pack the fixed-layout journal the guest commits and the contract parses
/// (big-endian). Reserves/net_custodied are widened to `i128` to match the
/// contract's on-chain types.
pub fn pack_journal(o: &AuditOutcome, pi: &PublicInputs) -> Vec<u8> {
    let mut v = Vec::with_capacity(JOURNAL_LEN);
    v.extend_from_slice(&o.liabilities_root);
    v.extend_from_slice(&pi.domain);
    v.extend_from_slice(&i128::from(pi.reserves).to_be_bytes());
    v.extend_from_slice(&i128::from(pi.net_custodied).to_be_bytes());
    v.extend_from_slice(&pi.ratio_bps.to_be_bytes());
    v.extend_from_slice(&pi.epoch.to_be_bytes());
    v.push(u8::from(o.reserves_checked));
    v.push(u8::from(o.floor_checked));
    v.push(u8::from(o.solvent));
    debug_assert_eq!(v.len(), JOURNAL_LEN);
    v
}

/// Parse a journal produced by [`pack_journal`]. Returns `None` on wrong length.
pub fn parse_journal(b: &[u8]) -> Option<Journal> {
    if b.len() != JOURNAL_LEN {
        return None;
    }
    let mut root = [0u8; 32];
    root.copy_from_slice(&b[0..32]);
    let mut domain = [0u8; 32];
    domain.copy_from_slice(&b[32..64]);
    let mut r = [0u8; 16];
    r.copy_from_slice(&b[64..80]);
    let mut nc = [0u8; 16];
    nc.copy_from_slice(&b[80..96]);
    let mut ratio = [0u8; 4];
    ratio.copy_from_slice(&b[96..100]);
    let mut epoch = [0u8; 4];
    epoch.copy_from_slice(&b[100..104]);
    Some(Journal {
        liabilities_root: root,
        domain,
        reserves: i128::from_be_bytes(r),
        net_custodied: i128::from_be_bytes(nc),
        ratio_bps: u32::from_be_bytes(ratio),
        epoch: u32::from_be_bytes(epoch),
        reserves_checked: b[104] != 0,
        floor_checked: b[105] != 0,
        solvent: b[106] != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(b: u64, tag: u8) -> Leaf {
        Leaf {
            account: [tag; 32],
            balance: b,
            salt: [tag.wrapping_add(100); 32],
        }
    }

    #[test]
    fn journal_roundtrips() {
        let leaves = vec![leaf(500_000, 1), leaf(300_000, 2), leaf(100_000, 3)];
        let pi = PublicInputs {
            reserves: 1_000_000,
            net_custodied: 900_000,
            ratio_bps: 10_000,
            epoch: 1,
            domain: [7u8; 32],
        };
        let (o, l) = run_audit(&leaves, &pi);
        assert_eq!(l, 900_000);
        assert!(o.solvent);
        let bytes = pack_journal(&o, &pi);
        assert_eq!(bytes.len(), JOURNAL_LEN);
        let j = parse_journal(&bytes).unwrap();
        assert_eq!(j.liabilities_root, o.liabilities_root);
        assert_eq!(j.reserves, 1_000_000);
        assert_eq!(j.net_custodied, 900_000);
        assert_eq!(j.epoch, 1);
        assert!(j.solvent);
    }

    #[test]
    fn insolvent_when_reserves_below_l() {
        let leaves = vec![leaf(500_000, 1), leaf(500_000, 2)]; // L = 1_000_000
        let pi = PublicInputs {
            reserves: 900_000,
            net_custodied: 0,
            ratio_bps: 10_000,
            epoch: 1,
            domain: [0u8; 32],
        };
        let (o, _) = run_audit(&leaves, &pi);
        assert!(!o.reserves_checked);
        assert!(!o.solvent);
    }

    #[test]
    fn ratio_over_collateralization() {
        let leaves = vec![leaf(1_000_000, 1)]; // L = 1_000_000
        // reserves exactly 1:1 but require 105%
        let pi = PublicInputs {
            reserves: 1_000_000,
            net_custodied: 0,
            ratio_bps: 10_500,
            epoch: 1,
            domain: [0u8; 32],
        };
        let (o, _) = run_audit(&leaves, &pi);
        assert!(!o.solvent, "1:1 must fail the 105% ratio");
    }

    #[test]
    fn floor_fails_when_l_below_net_custodied() {
        let leaves = vec![leaf(100, 1)]; // L = 100 (operator under-reports the book)
        let pi = PublicInputs {
            reserves: 1_000_000,
            net_custodied: 500_000, // chain says 500k was custodied
            ratio_bps: 10_000,
            epoch: 1,
            domain: [0u8; 32],
        };
        let (o, _) = run_audit(&leaves, &pi);
        assert!(!o.floor_checked, "omission attack must fail L >= net_custodied");
        assert!(!o.solvent);
    }

    #[test]
    fn altering_a_leaf_changes_the_root() {
        let a = vec![leaf(500_000, 1), leaf(300_000, 2)];
        let b = vec![leaf(500_001, 1), leaf(300_000, 2)]; // one balance changed
        let (ra, _) = build_sum_tree(&a);
        let (rb, _) = build_sum_tree(&b);
        assert_ne!(ra, rb, "root must commit to the exact book");
    }
}
