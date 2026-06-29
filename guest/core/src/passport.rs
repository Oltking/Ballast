//! # ZK Credit Passport — shared predicate logic
//!
//! A **portable, private reputation credential**. A lending protocol (the
//! "issuer") maintains a set of borrower records and publishes a single Merkle
//! **root** of them on-chain (the registry's per-predicate *anchor*). A borrower
//! then proves, in zero knowledge:
//!
//! > "A record for *me* is in the published set, and it shows
//! >  `repaid ≥ threshold` with **zero defaults**"
//!
//! revealing only their subject id, the public `threshold`, and the verdict —
//! **not** the actual counts, and **not** any other borrower's record. The
//! resulting credential is recorded in the generic registry and is reusable by
//! any app via `is_valid(subject, CREDIT_PASSPORT)`.
//!
//! ## Why this is honest ZK (not theatre)
//! - The proof is **load-bearing over hidden data**: the repayment/default
//!   counts and the rest of the book stay private; only the boolean escapes.
//! - It is **bound to chain**: the root committed in the journal must equal the
//!   anchor the registry holds, so a prover cannot invent a friendlier book.
//! - **Trust note:** the *contents* of the record set are attested by the issuer
//!   (the lending protocol). That issuer trust is the stated assumption for this
//!   predicate — it is the reputation analogue of the solvency vault's on-chain
//!   custody, and must be labelled wherever the Passport appears.
//!
//! This is a **plain** binary Merkle tree (no sums) — unlike the solvency
//! liabilities *sum* tree — because membership + per-leaf predicates are all we
//! need here; there is no total to commit.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::EMPTY_HASH;

/// One borrower's private record. `subject` is the 32-byte account id the
/// credential is about; `salt` hides the leaf preimage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreditRecord {
    pub subject: [u8; 32],
    pub repaid: u32,
    pub defaults: u32,
    pub salt: [u8; 32],
}

/// Public inputs echoed (bound) into the journal. `root` must equal the
/// registry's published anchor for this predicate; `threshold` is the public bar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PassportInputs {
    pub domain: [u8; 32],
    pub predicate_id: u32,
    pub nonce: u32,
    pub threshold: u32,
    pub root: [u8; 32],
}

/// One step of a plain-Merkle inclusion path: the sibling hash and which side
/// the proven node sits on at this level.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlainStep {
    pub sibling: [u8; 32],
    /// `true` if the proven node is the LEFT child here (sibling on the right).
    pub is_left: bool,
}

/// Decoded passport journal (host/contract side).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassportJournal {
    pub domain: [u8; 32],
    pub predicate_id: u32,
    pub subject: [u8; 32],
    pub nonce: u32,
    pub threshold: i128,
    pub result: bool,
    pub root: [u8; 32],
}

/// Journal layout = the registry's 89-byte generic envelope + a 32-byte anchor
/// (the Merkle root) tail: `domain[32] | predicate_id[4] | subject[32] |
/// nonce[4] | threshold(i128)[16] | result[1] | root[32]`.
pub const PASSPORT_JOURNAL_LEN: usize = 32 + 4 + 32 + 4 + 16 + 1 + 32; // 121

/// `sha256(subject || repaid_be || defaults_be || salt)`.
pub fn hash_credit_leaf(rec: &CreditRecord) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(rec.subject);
    h.update(rec.repaid.to_be_bytes());
    h.update(rec.defaults.to_be_bytes());
    h.update(rec.salt);
    h.finalize().into()
}

/// Plain internal node: `sha256(left || right)`.
fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(left);
    h.update(right);
    h.finalize().into()
}

/// Build the published Merkle root over the borrower records (padded to a power
/// of two with empty leaves). The issuer publishes this as the registry anchor.
pub fn build_credit_root(records: &[CreditRecord]) -> [u8; 32] {
    if records.is_empty() {
        return EMPTY_HASH;
    }
    let mut level: Vec<[u8; 32]> = records.iter().map(hash_credit_leaf).collect();
    while level.len() < level.len().next_power_of_two() {
        level.push(EMPTY_HASH);
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash_pair(&pair[0], &pair[1]));
        }
        level = next;
    }
    level[0]
}

/// Build an inclusion path for the record at `index` (pre-padding order).
pub fn prove_credit_inclusion(
    records: &[CreditRecord],
    index: usize,
) -> Option<(CreditRecord, Vec<PlainStep>)> {
    if index >= records.len() {
        return None;
    }
    let rec = records[index].clone();
    let mut level: Vec<[u8; 32]> = records.iter().map(hash_credit_leaf).collect();
    while level.len() < level.len().next_power_of_two() {
        level.push(EMPTY_HASH);
    }
    let mut idx = index;
    let mut path = Vec::new();
    while level.len() > 1 {
        let is_left = idx % 2 == 0;
        let sib = if is_left { idx + 1 } else { idx - 1 };
        path.push(PlainStep { sibling: level[sib], is_left });
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash_pair(&pair[0], &pair[1]));
        }
        level = next;
        idx /= 2;
    }
    Some((rec, path))
}

/// Recompute the root from a record + path and compare to `root`.
pub fn verify_credit_inclusion(rec: &CreditRecord, path: &[PlainStep], root: &[u8; 32]) -> bool {
    let mut h = hash_credit_leaf(rec);
    for step in path {
        h = if step.is_left {
            hash_pair(&h, &step.sibling)
        } else {
            hash_pair(&step.sibling, &h)
        };
    }
    &h == root
}

/// Evaluate the passport predicate: the record is in the published set **and**
/// shows `repaid >= threshold` **and** zero defaults.
pub fn eval_passport(rec: &CreditRecord, path: &[PlainStep], pi: &PassportInputs) -> bool {
    verify_credit_inclusion(rec, path, &pi.root)
        && rec.repaid >= pi.threshold
        && rec.defaults == 0
}

/// Pack the journal the guest commits and the registry parses. The journal
/// `subject` is taken from the record (so the credential lands under the right
/// account), and the `root` tail is the anchor the registry binds against.
pub fn pack_passport_journal(rec: &CreditRecord, pi: &PassportInputs, result: bool) -> Vec<u8> {
    let mut v = Vec::with_capacity(PASSPORT_JOURNAL_LEN);
    v.extend_from_slice(&pi.domain);
    v.extend_from_slice(&pi.predicate_id.to_be_bytes());
    v.extend_from_slice(&rec.subject);
    v.extend_from_slice(&pi.nonce.to_be_bytes());
    v.extend_from_slice(&i128::from(pi.threshold).to_be_bytes());
    v.push(u8::from(result));
    v.extend_from_slice(&pi.root);
    debug_assert_eq!(v.len(), PASSPORT_JOURNAL_LEN);
    v
}

/// Parse a journal produced by [`pack_passport_journal`]. `None` on wrong length.
pub fn parse_passport_journal(b: &[u8]) -> Option<PassportJournal> {
    if b.len() != PASSPORT_JOURNAL_LEN {
        return None;
    }
    let mut domain = [0u8; 32];
    domain.copy_from_slice(&b[0..32]);
    let mut predicate_id = [0u8; 4];
    predicate_id.copy_from_slice(&b[32..36]);
    let mut subject = [0u8; 32];
    subject.copy_from_slice(&b[36..68]);
    let mut nonce = [0u8; 4];
    nonce.copy_from_slice(&b[68..72]);
    let mut threshold = [0u8; 16];
    threshold.copy_from_slice(&b[72..88]);
    let result = b[88] != 0;
    let mut root = [0u8; 32];
    root.copy_from_slice(&b[89..121]);
    Some(PassportJournal {
        domain,
        predicate_id: u32::from_be_bytes(predicate_id),
        subject,
        nonce: u32::from_be_bytes(nonce),
        threshold: i128::from_be_bytes(threshold),
        result,
        root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(sub: u8, repaid: u32, defaults: u32) -> CreditRecord {
        CreditRecord {
            subject: [sub; 32],
            repaid,
            defaults,
            salt: [sub.wrapping_add(40); 32],
        }
    }

    fn book() -> Vec<CreditRecord> {
        std::vec![
            rec(1, 12, 0), // good standing
            rec(2, 3, 2),  // has defaults
            rec(3, 0, 0),  // brand new
            rec(4, 25, 0),
        ]
    }

    fn inputs(root: [u8; 32], threshold: u32) -> PassportInputs {
        PassportInputs { domain: [7u8; 32], predicate_id: 11, nonce: 1, threshold, root }
    }

    #[test]
    fn good_borrower_passes() {
        let b = book();
        let root = build_credit_root(&b);
        let (r, path) = prove_credit_inclusion(&b, 0).unwrap();
        assert!(eval_passport(&r, &path, &inputs(root, 10)));
    }

    #[test]
    fn borrower_with_defaults_fails() {
        let b = book();
        let root = build_credit_root(&b);
        let (r, path) = prove_credit_inclusion(&b, 1).unwrap(); // defaults = 2
        assert!(!eval_passport(&r, &path, &inputs(root, 1)));
    }

    #[test]
    fn below_threshold_fails() {
        let b = book();
        let root = build_credit_root(&b);
        let (r, path) = prove_credit_inclusion(&b, 0).unwrap(); // repaid = 12
        assert!(!eval_passport(&r, &path, &inputs(root, 20)));
    }

    #[test]
    fn tampered_record_breaks_inclusion() {
        // The borrower claims more repayments than the published book records.
        let b = book();
        let root = build_credit_root(&b);
        let (mut r, path) = prove_credit_inclusion(&b, 0).unwrap();
        r.repaid += 100;
        assert!(!eval_passport(&r, &path, &inputs(root, 10)));
    }

    #[test]
    fn record_not_in_published_set_fails() {
        let b = book();
        let root = build_credit_root(&b);
        let (_r, path) = prove_credit_inclusion(&b, 0).unwrap();
        let outsider = rec(99, 1000, 0); // never in the book
        assert!(!eval_passport(&outsider, &path, &inputs(root, 1)));
    }

    #[test]
    fn every_real_record_verifies_inclusion() {
        let b = book();
        let root = build_credit_root(&b);
        for i in 0..b.len() {
            let (r, path) = prove_credit_inclusion(&b, i).unwrap();
            assert!(verify_credit_inclusion(&r, &path, &root), "record {i}");
        }
    }

    #[test]
    fn journal_roundtrips() {
        let b = book();
        let root = build_credit_root(&b);
        let (r, path) = prove_credit_inclusion(&b, 3).unwrap();
        let pi = inputs(root, 10);
        let result = eval_passport(&r, &path, &pi);
        assert!(result);
        let bytes = pack_passport_journal(&r, &pi, result);
        assert_eq!(bytes.len(), PASSPORT_JOURNAL_LEN);
        let j = parse_passport_journal(&bytes).unwrap();
        assert_eq!(j.subject, r.subject);
        assert_eq!(j.threshold, 10);
        assert_eq!(j.root, root);
        assert!(j.result);
        assert_eq!(j.domain, pi.domain);
        assert_eq!(j.predicate_id, 11);
    }

    #[test]
    fn altering_a_record_changes_the_root() {
        let mut b = book();
        let r1 = build_credit_root(&b);
        b[0].repaid += 1;
        let r2 = build_credit_root(&b);
        assert_ne!(r1, r2, "root must commit to the exact book");
    }
}
