#![no_std]
//! # Ballast Credential Registry
//!
//! A **generic** zero-knowledge credential registry for Stellar. Where the
//! Ballast *vault* verifies one specific predicate (`reserves >= liabilities`)
//! and enforces it, this registry is the substrate underneath: it verifies and
//! records **any** RISC Zero predicate proof, so a single deployed Groth16
//! verifier can back many claim types ("balance ≥ X", "treasury ≥ Y",
//! "member of set S", …). The vault becomes just one consumer of the same
//! cryptographic root of trust.
//!
//! ## What the registry guarantees (and what it deliberately does not)
//! It guarantees a recorded credential is **authentic, bound, and fresh**:
//! - **authentic** — the Groth16 seal verifies against the predicate's pinned
//!   `image_id` (traps otherwise); only the exact registered guest program could
//!   have produced it;
//! - **bound** — the journal's `domain` equals this registry (no cross-contract
//!   proof reuse) and its `subject` names who the credential is about (no
//!   re-targeting Alice's proof onto Bob);
//! - **fresh / non-replayable** — a strictly increasing per-(subject, predicate)
//!   `nonce`, plus a ledger stamp so consumers can require recency.
//!
//! It does **not** interpret predicate semantics. *What* `result == true` means
//! is defined entirely by the guest program identified by `image_id`; the
//! registry treats the journal tail opaquely (it is still covered by the seal's
//! SHA-256 digest, so it cannot be tampered with). This is what makes it
//! generic: new predicates ship as new guests + an admin `register_predicate`,
//! with **no contract redeploy**.
//!
//! ## Trust note (per the project's non-negotiables)
//! A predicate is only *trustless* if its guest binds the proven quantity to
//! data the chain holds (as the solvency vault binds `reserves` to its live
//! balance). Predicates over issuer-attested off-chain facts (salary, credit)
//! are legitimate but introduce trust in that issuer — that must be labelled
//! wherever such a predicate is registered. The registry is neutral to this; the
//! distinction lives in each predicate's guest + its published description.

use soroban_sdk::{
    contract, contractclient, contractevent, contracterror, contractimpl, contracttype,
    panic_with_error, Address, Bytes, BytesN, Env, String,
};

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// `register_predicate` for an id that already exists (use `set_predicate`).
    PredicateExists = 3,
    /// `submit`/`set_predicate` for an unregistered or inactive predicate id.
    PredicateUnknown = 4,
    /// Journal shorter than the generic envelope.
    BadJournal = 5,
    /// Journal `domain` != this registry (cross-contract proof reuse).
    DomainMismatch = 6,
    /// Journal `nonce` not strictly greater than the recorded one (stale/replay).
    StaleNonce = 7,
    /// The proof's verdict is `false` — a failing predicate is never recorded.
    PredicateFailed = 8,
    /// `fresh_window` of zero at registration.
    InvalidConfig = 9,
    /// Predicate declares an on-chain anchor, but the journal's anchor (the
    /// 32-byte tail after the envelope) is missing or doesn't match it.
    AnchorMismatch = 10,
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/// A registered claim type. `image_id` pins the RISC Zero guest whose proofs are
/// accepted for this predicate; `fresh_window` is the recency window (in ledgers)
/// a consumer's `is_valid` defaults to. `label` is a human description.
///
/// `anchor` binds proofs to an on-chain dataset: when non-zero, every submitted
/// journal must carry that exact 32 bytes as its tail (after the generic
/// envelope). This is what keeps set-membership-style predicates (allowlists,
/// credit-record books) **trustless** — a prover can't fabricate their own
/// Merkle root; it must equal the one the admin published here. All-zero = no
/// anchor (e.g. for self-contained predicates that bind everything in-guest).
#[contracttype]
#[derive(Clone)]
pub struct PredicateDef {
    pub image_id: BytesN<32>,
    pub fresh_window: u32,
    pub label: String,
    pub anchor: BytesN<32>,
    pub active: bool,
}

/// A recorded credential: predicate `predicate_id` holds for `subject` as of
/// `ledger`, with public parameter `param` (e.g. the threshold X in "≥ X"; 0 if
/// the predicate carries none). The private value behind the claim is never here.
#[contracttype]
#[derive(Clone)]
pub struct Credential {
    pub subject: BytesN<32>,
    pub predicate_id: u32,
    pub param: i128,
    pub nonce: u32,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    /// `stellar-risc0-verifier` (router or standalone groth16-verifier) contract id.
    pub verifier: Address,
    /// Domain-separation tag bound into every journal (this registry's contract id).
    pub domain: BytesN<32>,
}

// ----------------------------------------------------------------------------
// RISC Zero verifier client — matches NethermindEth/stellar-risc0-verifier.
// `verify` traps if the seal is not a valid Groth16 proof for (image_id, journal).
// ----------------------------------------------------------------------------

#[contractclient(name = "VerifierClient")]
pub trait RiscZeroVerifier {
    fn verify(env: Env, seal: Bytes, image_id: BytesN<32>, journal: BytesN<32>);
}

/// Generic journal envelope (big-endian), the fixed prefix of every predicate's
/// journal. Predicates may append predicate-specific bytes after it (e.g. a
/// commitment / Merkle root); those are still covered by the seal's SHA-256
/// digest but are opaque to the registry.
///
/// `domain[32] | predicate_id(u32)[4] | subject[32] | nonce(u32)[4] |
///  param(i128)[16] | result[1]`
const ENVELOPE_LEN: u32 = 32 + 4 + 32 + 4 + 16 + 1; // 89

// ----------------------------------------------------------------------------
// Events
// ----------------------------------------------------------------------------

#[contractevent]
#[derive(Clone)]
pub struct PredicateRegistered {
    #[topic]
    pub predicate_id: u32,
    pub image_id: BytesN<32>,
    pub fresh_window: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct Credentialed {
    #[topic]
    pub subject: BytesN<32>,
    #[topic]
    pub predicate_id: u32,
    pub param: i128,
    pub nonce: u32,
    pub ledger: u32,
}

// ----------------------------------------------------------------------------
// Storage
// ----------------------------------------------------------------------------

/// Composite key for a per-(subject, predicate) credential.
#[contracttype]
#[derive(Clone)]
pub struct CredKey {
    pub subject: BytesN<32>,
    pub predicate_id: u32,
}

#[contracttype]
pub enum DataKey {
    /// `Config`
    Config,
    /// `PredicateDef` keyed by predicate id.
    Predicate(u32),
    /// `Credential` keyed by (subject, predicate id).
    Cred(CredKey),
}

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;
// Credentials are persistent (potentially many subjects); keep them alive a
// generous window so consumers can read them between refreshes.
const CRED_BUMP_AMOUNT: u32 = 60 * DAY_IN_LEDGERS;
const CRED_LIFETIME_THRESHOLD: u32 = CRED_BUMP_AMOUNT - DAY_IN_LEDGERS;

fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with(env, Error::NotInitialized))
}

fn get_predicate(env: &Env, id: u32) -> PredicateDef {
    let pd: PredicateDef = env
        .storage()
        .instance()
        .get(&DataKey::Predicate(id))
        .unwrap_or_else(|| panic_with(env, Error::PredicateUnknown));
    if !pd.active {
        panic_with(env, Error::PredicateUnknown);
    }
    pd
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn panic_with(env: &Env, e: Error) -> ! {
    panic_with_error!(env, e)
}

// ----------------------------------------------------------------------------
// Contract
// ----------------------------------------------------------------------------

#[contract]
pub struct RegistryContract;

#[contractimpl]
impl RegistryContract {
    /// Initialize the registry. `domain` should be this contract's own id so
    /// proofs can't be replayed against a different deployment. Idempotent-guarded.
    pub fn initialize(env: Env, admin: Address, verifier: Address, domain: BytesN<32>) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with(&env, Error::AlreadyInitialized);
        }
        env.storage()
            .instance()
            .set(&DataKey::Config, &Config { admin, verifier, domain });
        bump_instance(&env);
    }

    /// Register a new predicate (claim type). Admin-only. Fails if the id is
    /// already taken — use `set_predicate` to update an existing one.
    /// Register a new predicate (claim type). Admin-only. Fails if the id is
    /// already taken — use `set_predicate` to update an existing one. Pass an
    /// all-zero `anchor` for predicates that bind everything in-guest, or a
    /// published Merkle root for set-membership-style predicates.
    pub fn register_predicate(
        env: Env,
        predicate_id: u32,
        image_id: BytesN<32>,
        fresh_window: u32,
        label: String,
        anchor: BytesN<32>,
    ) {
        let cfg = get_config(&env);
        cfg.admin.require_auth();
        if fresh_window == 0 {
            panic_with(&env, Error::InvalidConfig);
        }
        if env.storage().instance().has(&DataKey::Predicate(predicate_id)) {
            panic_with(&env, Error::PredicateExists);
        }
        env.storage().instance().set(
            &DataKey::Predicate(predicate_id),
            &PredicateDef { image_id: image_id.clone(), fresh_window, label, anchor, active: true },
        );
        bump_instance(&env);
        PredicateRegistered { predicate_id, image_id, fresh_window }.publish(&env);
    }

    /// Update an existing predicate: re-pin its `image_id` after a guest upgrade,
    /// change the freshness window, **roll the anchor** (e.g. publish a new
    /// record-set root), or deactivate it. Admin-only.
    pub fn set_predicate(
        env: Env,
        predicate_id: u32,
        image_id: BytesN<32>,
        fresh_window: u32,
        anchor: BytesN<32>,
        active: bool,
    ) {
        let cfg = get_config(&env);
        cfg.admin.require_auth();
        if fresh_window == 0 {
            panic_with(&env, Error::InvalidConfig);
        }
        if !env.storage().instance().has(&DataKey::Predicate(predicate_id)) {
            panic_with(&env, Error::PredicateUnknown);
        }
        // Pull the current label so callers don't have to restate it.
        let prev: PredicateDef = env
            .storage()
            .instance()
            .get(&DataKey::Predicate(predicate_id))
            .unwrap();
        env.storage().instance().set(
            &DataKey::Predicate(predicate_id),
            &PredicateDef {
                image_id: image_id.clone(),
                fresh_window,
                label: prev.label,
                anchor,
                active,
            },
        );
        bump_instance(&env);
        PredicateRegistered { predicate_id, image_id, fresh_window }.publish(&env);
    }

    /// Verify a predicate proof and record the credential. **Permissionless** —
    /// the proof is self-authorizing (only the subject's own private data, run
    /// through the pinned guest, can produce a valid seal for that subject), so
    /// anyone may relay it. Replay is blocked by the strictly-increasing nonce.
    ///
    /// Flow: parse the generic envelope → bind `domain` to this registry → look
    /// up the predicate's pinned `image_id` → verify the Groth16 seal over
    /// `sha256(journal)` (traps on a bad proof) → require `result == true` →
    /// require `nonce` strictly greater than any recorded one → record + emit.
    pub fn submit(env: Env, journal: Bytes, seal: Bytes) {
        let cfg = get_config(&env);

        // 1. Parse the generic envelope.
        if journal.len() < ENVELOPE_LEN {
            panic_with(&env, Error::BadJournal);
        }
        let domain = read_bytes32(&env, &journal, 0);
        let predicate_id = read_u32(&journal, 32);
        let subject = read_bytes32(&env, &journal, 36);
        let nonce = read_u32(&journal, 68);
        let param = read_i128(&journal, 72);
        let result = journal.get(88).unwrap_or(0) != 0;

        // 2. Bind to this registry.
        if domain != cfg.domain {
            panic_with(&env, Error::DomainMismatch);
        }

        // 3. Resolve the predicate and cryptographically verify the seal against
        //    its pinned guest image. Traps on a bad/forged proof.
        let pd = get_predicate(&env, predicate_id);
        let journal_digest: BytesN<32> = env.crypto().sha256(&journal).to_bytes();
        VerifierClient::new(&env, &cfg.verifier).verify(&seal, &pd.image_id, &journal_digest);

        // 4. If the predicate is anchored to an on-chain dataset, the journal's
        //    tail (bytes after the envelope) must carry that exact anchor — so a
        //    prover can't swap in a Merkle root of their own making.
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        if pd.anchor != zero {
            if journal.len() < ENVELOPE_LEN + 32 {
                panic_with(&env, Error::AnchorMismatch);
            }
            if read_bytes32(&env, &journal, ENVELOPE_LEN) != pd.anchor {
                panic_with(&env, Error::AnchorMismatch);
            }
        }

        // 5. A failing predicate is never recorded as a credential.
        if !result {
            panic_with(&env, Error::PredicateFailed);
        }

        // 6. Anti-replay: nonce must strictly exceed any recorded one.
        let key = CredKey { subject: subject.clone(), predicate_id };
        let dk = DataKey::Cred(key);
        if let Some(prev) = env.storage().persistent().get::<_, Credential>(&dk) {
            if nonce <= prev.nonce {
                panic_with(&env, Error::StaleNonce);
            }
        }

        // 7. Record.
        let ledger = env.ledger().sequence();
        let cred = Credential { subject: subject.clone(), predicate_id, param, nonce, ledger };
        env.storage().persistent().set(&dk, &cred);
        env.storage()
            .persistent()
            .extend_ttl(&dk, CRED_LIFETIME_THRESHOLD, CRED_BUMP_AMOUNT);
        bump_instance(&env);

        Credentialed { subject, predicate_id, param, nonce, ledger }.publish(&env);
    }

    // ----- Views -----

    pub fn config(env: Env) -> Config {
        get_config(&env)
    }

    /// The definition of a registered predicate, if any.
    pub fn predicate(env: Env, predicate_id: u32) -> Option<PredicateDef> {
        env.storage().instance().get(&DataKey::Predicate(predicate_id))
    }

    /// The most recent credential recorded for `(subject, predicate_id)`, if any.
    pub fn credential(env: Env, subject: BytesN<32>, predicate_id: u32) -> Option<Credential> {
        env.storage()
            .persistent()
            .get(&DataKey::Cred(CredKey { subject, predicate_id }))
    }

    /// Composability gate: `true` iff `subject` holds a credential for
    /// `predicate_id` that is within `max_age` ledgers **and** within the
    /// predicate's own `fresh_window`. Pass `max_age == 0` to use the predicate's
    /// window alone. Other Soroban contracts (or the frontend) call this to gate
    /// on a fresh, verified claim — turning the registry into infrastructure.
    pub fn is_valid(env: Env, subject: BytesN<32>, predicate_id: u32, max_age: u32) -> bool {
        let pd: PredicateDef = match env.storage().instance().get(&DataKey::Predicate(predicate_id)) {
            Some(pd) => pd,
            None => return false,
        };
        if !pd.active {
            return false;
        }
        let cred: Credential = match env
            .storage()
            .persistent()
            .get(&DataKey::Cred(CredKey { subject, predicate_id }))
        {
            Some(c) => c,
            None => return false,
        };
        let age = env.ledger().sequence().saturating_sub(cred.ledger);
        if age > pd.fresh_window {
            return false;
        }
        max_age == 0 || age <= max_age
    }
}

// --- fixed-layout journal readers (caller guarantees len >= ENVELOPE_LEN) ---

fn read_bytes32(env: &Env, b: &Bytes, off: u32) -> BytesN<32> {
    let mut a = [0u8; 32];
    for (k, slot) in a.iter_mut().enumerate() {
        *slot = b.get(off + k as u32).unwrap_or(0);
    }
    BytesN::from_array(env, &a)
}

fn read_i128(b: &Bytes, off: u32) -> i128 {
    let mut v: i128 = 0;
    for k in 0..16u32 {
        v = (v << 8) | i128::from(b.get(off + k).unwrap_or(0));
    }
    v
}

fn read_u32(b: &Bytes, off: u32) -> u32 {
    let mut v: u32 = 0;
    for k in 0..4u32 {
        v = (v << 8) | u32::from(b.get(off + k).unwrap_or(0));
    }
    v
}

#[cfg(test)]
mod test;
