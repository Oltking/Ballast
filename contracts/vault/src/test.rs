#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

// ----------------------------------------------------------------------------
// Test-only verifier doubles (NOT used in production; production points the
// vault at the real Nethermind risc0-verifier router).
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
        panic_with_error!(&env, Error::Insolvent);
    }
}

const DOMAIN: [u8; 32] = [9u8; 32];

struct Setup<'a> {
    env: Env,
    vault: VaultContractClient<'a>,
    token: TokenClient<'a>,
    token_admin: StellarAssetClient<'a>,
    operator: Address,
    depositor: Address,
}

/// Default setup: registers a passing verifier double in the same env as the vault.
fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    setup_with_verifier_in(env, verifier)
}

// Build a 107-byte journal using the *guest's* packer so the contract parser and
// the guest can never drift. `domain` defaults to DOMAIN.
fn make_journal(
    env: &Env,
    leaves_balances: &[u64],
    reserves: u64,
    net_custodied: u64,
    ratio_bps: u32,
    epoch: u32,
    domain: [u8; 32],
) -> Bytes {
    let leaves: std::vec::Vec<ballast_core::Leaf> = leaves_balances
        .iter()
        .enumerate()
        .map(|(i, b)| ballast_core::Leaf {
            account: [i as u8; 32],
            balance: *b,
            salt: [(i as u8).wrapping_add(50); 32],
        })
        .collect();
    let pi = ballast_core::PublicInputs {
        reserves,
        net_custodied,
        ratio_bps,
        epoch,
        domain,
    };
    let (outcome, _l) = ballast_core::run_audit(&leaves, &pi);
    let bytes = ballast_core::pack_journal(&outcome, &pi);
    Bytes::from_slice(env, &bytes)
}

fn fund_vault(s: &Setup, amount: i128) {
    s.token_admin.mint(&s.depositor, &amount);
    s.vault.deposit(&s.depositor, &amount);
}

// =================== P1: custody + accounting ===================

#[test]
fn deposit_increases_net_custodied_and_reserves() {
    let s = setup();
    s.token_admin.mint(&s.depositor, &1_000);
    s.vault.deposit(&s.depositor, &600);
    assert_eq!(s.vault.net_custodied(), 600);
    assert_eq!(s.vault.reserves(), 600);
    assert_eq!(s.token.balance(&s.depositor), 400);
    assert_eq!(s.vault.epoch(), 0);
}

#[test]
fn user_withdrawal_reduces_net_custodied() {
    let s = setup();
    fund_vault(&s, 1_000);
    let user = Address::generate(&s.env);
    s.vault.withdraw_user(&user, &250);
    assert_eq!(s.vault.net_custodied(), 750);
    assert_eq!(s.token.balance(&user), 250);
}

#[test]
fn operator_withdrawal_reduces_net_custodied() {
    let s = setup();
    fund_vault(&s, 1_000);
    s.vault.withdraw_operator(&300);
    assert_eq!(s.vault.net_custodied(), 700);
    assert_eq!(s.token.balance(&s.operator), 300);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InsufficientCustodied
fn cannot_withdraw_more_than_custodied() {
    let s = setup();
    fund_vault(&s, 500);
    s.vault.withdraw_operator(&501);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidAmount
fn rejects_nonpositive_deposit() {
    let s = setup();
    s.vault.deposit(&s.depositor, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // AlreadyInitialized
fn cannot_initialize_twice() {
    let s = setup();
    let any = Address::generate(&s.env);
    let image_id = BytesN::from_array(&s.env, &[0u8; 32]);
    let domain = BytesN::from_array(&s.env, &DOMAIN);
    s.vault.initialize(
        &any, &any, &any, &any, &image_id, &Mode::AttestationOnly, &17_280u32, &10_000u32, &domain,
    );
}

// =================== P3: on-chain verification + attestation ===================

#[test]
fn accepts_valid_solvent_attestation() {
    let s = setup();
    fund_vault(&s, 1_000_000); // reserves = net_custodied = 1_000_000

    // L = 1_000_000 (== reserves, == net_custodied) → solvent at 100%.
    let journal = make_journal(
        &s.env,
        &[600_000, 400_000],
        1_000_000,
        1_000_000,
        10_000,
        1,
        DOMAIN,
    );
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);

    assert_eq!(s.vault.epoch(), 1);
    let att = s.vault.latest_attestation().unwrap();
    assert!(att.solvent);
    assert_eq!(att.reserves, 1_000_000);
    assert_eq!(att.epoch, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // EpochMismatch (replay)
fn rejects_replayed_attestation() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
    // replay the same (epoch 1) proof — stored epoch is now 1, expects 2
    s.vault.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")] // ReservesMismatch
fn rejects_reserves_mismatch() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    // journal claims reserves = 999_999, but live balance is 1_000_000
    let journal = make_journal(&s.env, &[999_999], 999_999, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // DomainMismatch
fn rejects_wrong_domain() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, [1u8; 32]);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")] // Insolvent (reserves < L)
fn rejects_insolvent_proof() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    // L = 1_000_001 > reserves 1_000_000 → reserves_checked false → solvent false
    let journal = make_journal(
        &s.env,
        &[1_000_001],
        1_000_000,
        1_000_000,
        10_000,
        1,
        DOMAIN,
    );
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
}

#[test]
#[should_panic] // verifier traps on a bad proof
fn rejects_when_verifier_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let reject = env.register(RejectVerifier, ());
    let s = setup_with_verifier_in(env, reject);
    fund_vault(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
}

// Helper that builds a Setup around an already-created env + verifier address.
fn setup_with_verifier_in(env: Env, verifier: Address) -> Setup<'static> {
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let depositor = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let reserve_token = sac.address();
    let token = TokenClient::new(&env, &reserve_token);
    let token_admin = StellarAssetClient::new(&env, &reserve_token);
    let image_id = BytesN::from_array(&env, &[0u8; 32]);
    let domain = BytesN::from_array(&env, &DOMAIN);
    let vault_id = env.register(VaultContract, ());
    let vault = VaultContractClient::new(&env, &vault_id);
    vault.initialize(
        &admin, &operator, &reserve_token, &verifier, &image_id, &Mode::Enforced, &17_280u32,
        &10_000u32, &domain,
    );
    Setup { env, vault, token, token_admin, operator, depositor }
}

#[test]
fn ledger_is_recorded_in_attestation() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    s.env.ledger().set_sequence_number(12345);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
    assert_eq!(s.vault.latest_attestation().unwrap().ledger, 12345);
}
