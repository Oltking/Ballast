#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, String,
};

// ----------------------------------------------------------------------------
// Test-only verifier doubles (production points at the real Nethermind
// stellar-risc0-verifier / groth16-verifier).
// ----------------------------------------------------------------------------

#[contract]
pub struct AcceptVerifier;
#[contractimpl]
impl AcceptVerifier {
    pub fn verify(_env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {}
}

#[contract]
pub struct RejectVerifier;
#[contractimpl]
impl RejectVerifier {
    pub fn verify(env: Env, _seal: Bytes, _image_id: BytesN<32>, _journal: BytesN<32>) {
        panic_with_error!(&env, Error::PredicateFailed);
    }
}

const DOMAIN: [u8; 32] = [9u8; 32];
const IMAGE: [u8; 32] = [3u8; 32];
const PRED: u32 = 7; // a sample predicate id

struct Setup<'a> {
    env: Env,
    reg: RegistryContractClient<'a>,
}

fn setup() -> Setup<'static> {
    setup_with(AcceptVerifier {})
}

fn setup_rejecting() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(RejectVerifier, ());
    let reg = init_registry(&env, verifier);
    Setup { env, reg }
}

fn setup_with(_v: AcceptVerifier) -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    let reg = init_registry(&env, verifier);
    Setup { env, reg }
}

fn init_registry<'a>(env: &Env, verifier: Address) -> RegistryContractClient<'a> {
    let admin = Address::generate(env);
    let domain = BytesN::from_array(env, &DOMAIN);
    let id = env.register(RegistryContract, ());
    let reg = RegistryContractClient::new(env, &id);
    reg.initialize(&admin, &verifier, &domain);
    // Register the sample predicate used across the happy-path tests.
    reg.register_predicate(
        &PRED,
        &BytesN::from_array(env, &IMAGE),
        &17_280u32,
        &String::from_str(env, "sample >= X"),
    );
    reg
}

/// Pack the generic envelope (matches `ENVELOPE_LEN` layout in lib.rs).
fn envelope(
    env: &Env,
    domain: [u8; 32],
    predicate_id: u32,
    subject: [u8; 32],
    nonce: u32,
    param: i128,
    result: bool,
) -> Bytes {
    let mut v = std::vec::Vec::with_capacity(89);
    v.extend_from_slice(&domain);
    v.extend_from_slice(&predicate_id.to_be_bytes());
    v.extend_from_slice(&subject);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(&param.to_be_bytes());
    v.push(u8::from(result));
    Bytes::from_slice(env, &v)
}

fn seal(env: &Env) -> Bytes {
    Bytes::from_array(env, &[1u8; 8])
}

fn subj(tag: u8) -> [u8; 32] {
    [tag; 32]
}

// =================== happy path ===================

#[test]
fn submit_records_a_credential() {
    let s = setup();
    let subject = subj(1);
    let j = envelope(&s.env, DOMAIN, PRED, subject, 1, 5_000, true);
    s.reg.submit(&j, &seal(&s.env));

    let key_subject = BytesN::from_array(&s.env, &subject);
    let cred = s.reg.credential(&key_subject, &PRED).unwrap();
    assert_eq!(cred.predicate_id, PRED);
    assert_eq!(cred.param, 5_000);
    assert_eq!(cred.nonce, 1);
    assert!(s.reg.is_valid(&key_subject, &PRED, &0u32));
}

#[test]
fn nonce_advances_and_overwrites() {
    let s = setup();
    let subject = subj(2);
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 1, 100, true), &seal(&s.env));
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 5, 200, true), &seal(&s.env));
    let cred = s.reg.credential(&BytesN::from_array(&s.env, &subject), &PRED).unwrap();
    assert_eq!(cred.nonce, 5);
    assert_eq!(cred.param, 200);
}

#[test]
fn distinct_subjects_are_independent() {
    let s = setup();
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subj(1), 1, 1, true), &seal(&s.env));
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subj(2), 1, 2, true), &seal(&s.env));
    assert_eq!(s.reg.credential(&BytesN::from_array(&s.env, &subj(1)), &PRED).unwrap().param, 1);
    assert_eq!(s.reg.credential(&BytesN::from_array(&s.env, &subj(2)), &PRED).unwrap().param, 2);
}

#[test]
fn journal_with_predicate_tail_is_accepted() {
    // The registry only reads the 89-byte envelope; predicate-specific trailing
    // bytes (e.g. a commitment) are covered by the seal digest but ignored here.
    let s = setup();
    let subject = subj(3);
    let mut v = std::vec::Vec::new();
    v.extend_from_slice(&DOMAIN);
    v.extend_from_slice(&PRED.to_be_bytes());
    v.extend_from_slice(&subject);
    v.extend_from_slice(&9u32.to_be_bytes());
    v.extend_from_slice(&42i128.to_be_bytes());
    v.push(1u8);
    v.extend_from_slice(&[0xab; 48]); // predicate tail
    let j = Bytes::from_slice(&s.env, &v);
    s.reg.submit(&j, &seal(&s.env));
    assert_eq!(s.reg.credential(&BytesN::from_array(&s.env, &subject), &PRED).unwrap().nonce, 9);
}

// =================== binding / anti-replay ===================

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // DomainMismatch
fn rejects_wrong_domain() {
    let s = setup();
    s.reg.submit(&envelope(&s.env, [1u8; 32], PRED, subj(1), 1, 0, true), &seal(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // StaleNonce (replay)
fn rejects_replayed_nonce() {
    let s = setup();
    let subject = subj(1);
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 3, 0, true), &seal(&s.env));
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 3, 0, true), &seal(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // StaleNonce (lower)
fn rejects_lower_nonce() {
    let s = setup();
    let subject = subj(1);
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 5, 0, true), &seal(&s.env));
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 4, 0, true), &seal(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // PredicateUnknown
fn rejects_unregistered_predicate() {
    let s = setup();
    s.reg.submit(&envelope(&s.env, DOMAIN, 999, subj(1), 1, 0, true), &seal(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // PredicateFailed
fn rejects_failing_verdict() {
    let s = setup();
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subj(1), 1, 0, false), &seal(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // BadJournal
fn rejects_short_journal() {
    let s = setup();
    let short = Bytes::from_array(&s.env, &[0u8; 10]);
    s.reg.submit(&short, &seal(&s.env));
}

#[test]
#[should_panic] // verifier double traps on a bad proof
fn rejects_when_verifier_rejects() {
    let s = setup_rejecting();
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subj(1), 1, 0, true), &seal(&s.env));
}

// =================== freshness ===================

#[test]
fn is_valid_expires_past_window() {
    let s = setup();
    let subject = subj(1);
    s.env.ledger().set_sequence_number(100);
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 1, 0, true), &seal(&s.env));
    let ks = BytesN::from_array(&s.env, &subject);
    assert!(s.reg.is_valid(&ks, &PRED, &0u32));
    s.env.ledger().set_sequence_number(100 + 17_281); // past the 17_280 window
    assert!(!s.reg.is_valid(&ks, &PRED, &0u32));
}

#[test]
fn is_valid_respects_caller_max_age() {
    let s = setup();
    let subject = subj(1);
    s.env.ledger().set_sequence_number(100);
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subject, 1, 0, true), &seal(&s.env));
    let ks = BytesN::from_array(&s.env, &subject);
    s.env.ledger().set_sequence_number(100 + 60);
    assert!(s.reg.is_valid(&ks, &PRED, &100u32)); // age 60 <= 100
    assert!(!s.reg.is_valid(&ks, &PRED, &50u32)); // age 60 > 50
}

#[test]
fn is_valid_false_for_unknown_subject_or_predicate() {
    let s = setup();
    let ks = BytesN::from_array(&s.env, &subj(1));
    assert!(!s.reg.is_valid(&ks, &PRED, &0u32)); // never submitted
    assert!(!s.reg.is_valid(&ks, &404u32, &0u32)); // predicate doesn't exist
}

// =================== predicate admin ===================

#[test]
fn register_and_read_predicate() {
    let s = setup();
    let pd = s.reg.predicate(&PRED).unwrap();
    assert_eq!(pd.image_id, BytesN::from_array(&s.env, &IMAGE));
    assert_eq!(pd.fresh_window, 17_280);
    assert!(pd.active);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // PredicateExists
fn cannot_register_duplicate_predicate() {
    let s = setup();
    s.reg.register_predicate(
        &PRED,
        &BytesN::from_array(&s.env, &IMAGE),
        &10u32,
        &String::from_str(&s.env, "dup"),
    );
}

#[test]
fn set_predicate_repins_and_keeps_label() {
    let s = setup();
    let new_img = BytesN::from_array(&s.env, &[8u8; 32]);
    s.reg.set_predicate(&PRED, &new_img, &500u32, &true);
    let pd = s.reg.predicate(&PRED).unwrap();
    assert_eq!(pd.image_id, new_img);
    assert_eq!(pd.fresh_window, 500);
    assert_eq!(pd.label, String::from_str(&s.env, "sample >= X")); // preserved
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // PredicateUnknown (deactivated)
fn deactivated_predicate_rejects_submit() {
    let s = setup();
    s.reg.set_predicate(&PRED, &BytesN::from_array(&s.env, &IMAGE), &17_280u32, &false);
    s.reg.submit(&envelope(&s.env, DOMAIN, PRED, subj(1), 1, 0, true), &seal(&s.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // AlreadyInitialized
fn cannot_initialize_twice() {
    let s = setup();
    let any = Address::generate(&s.env);
    s.reg.initialize(&any, &any, &BytesN::from_array(&s.env, &DOMAIN));
}

// auth: registering without the admin signature must fail.
#[test]
#[should_panic] // admin auth required
fn register_predicate_requires_admin_auth() {
    let env = Env::default(); // no mock_all_auths
    let admin = Address::generate(&env);
    let verifier = env.register(AcceptVerifier, ());
    let id = env.register(RegistryContract, ());
    let reg = RegistryContractClient::new(&env, &id);
    env.mock_all_auths();
    reg.initialize(&admin, &verifier, &BytesN::from_array(&env, &DOMAIN));
    env.set_auths(&[]); // drop mocked auths
    reg.register_predicate(
        &1u32,
        &BytesN::from_array(&env, &IMAGE),
        &10u32,
        &String::from_str(&env, "x"),
    );
}
