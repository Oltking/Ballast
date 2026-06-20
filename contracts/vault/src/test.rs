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

/// Default setup (AttestationOnly): registers a passing verifier double in the
/// same env as the vault. Custody flows are ungated in this mode.
fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    setup_with_verifier_mode(env, verifier, Mode::AttestationOnly)
}

/// Enforced-mode setup with a passing verifier double (for P4 gate tests).
fn setup_enforced() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    setup_with_verifier_mode(env, verifier, Mode::Enforced)
}

/// Post a solvent attestation at `epoch` (uses the guest packer; verifier double accepts).
fn attest_solvent(s: &Setup, leaves: &[u64], reserves: u64, net_custodied: u64, epoch: u32) {
    let journal = make_journal(&s.env, leaves, reserves, net_custodied, 10_000, epoch, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
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
fn operator_withdrawal_does_not_reduce_net_custodied() {
    // Operator outflows (fees/rehypothecation) don't discharge user liabilities,
    // so `net_custodied` is unchanged; only reserves drop. (AttestationOnly: ungated.)
    let s = setup();
    fund_vault(&s, 1_000);
    s.vault.withdraw_operator(&300);
    assert_eq!(s.vault.net_custodied(), 1_000);
    assert_eq!(s.vault.reserves(), 700);
    assert_eq!(s.token.balance(&s.operator), 300);
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")] // InsufficientReserves
fn operator_cannot_withdraw_more_than_reserves() {
    let s = setup();
    fund_vault(&s, 500);
    s.vault.withdraw_operator(&501);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InsufficientCustodied
fn user_cannot_withdraw_more_than_custodied() {
    let s = setup();
    fund_vault(&s, 500);
    let user = Address::generate(&s.env);
    s.vault.withdraw_user(&user, &501);
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
fn insolvent_proof_is_recorded_as_not_solvent() {
    // F5: an insolvent proof is no longer rejected — it is recorded (solvent=false)
    // and trips the breaker into WindDown.
    let s = setup();
    fund_vault(&s, 1_000_000);
    // L = 1_000_001 > reserves 1_000_000 → reserves_checked false → solvent false
    let journal = make_journal(&s.env, &[1_000_001], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
    assert!(!s.vault.latest_attestation().unwrap().solvent);
    assert_eq!(s.vault.status(), Status::WindDown);
    assert_eq!(s.vault.epoch(), 1);
}

#[test]
#[should_panic] // verifier traps on a bad proof
fn rejects_when_verifier_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let reject = env.register(RejectVerifier, ());
    let s = setup_with_verifier_mode(env, reject, Mode::AttestationOnly);
    fund_vault(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.vault.post_attestation(&journal, &seal);
}

// Helper that builds a Setup around an already-created env + verifier address.
fn setup_with_verifier_mode(env: Env, verifier: Address, mode: Mode) -> Setup<'static> {
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
        &admin, &operator, &reserve_token, &verifier, &image_id, &mode, &17_280u32,
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

// =================== P4: enforcement + staleness ===================

// Mint reserve tokens straight to the vault to create excess reserves ABOVE the
// custodied floor (models the operator's own capital buffer / rehypothecation slack).
fn add_excess_reserves(s: &Setup, amount: i128) {
    s.token_admin.mint(&s.vault.address, &amount);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // NoAttestation
fn enforced_blocks_operator_without_attestation() {
    let s = setup_enforced();
    fund_vault(&s, 1_000_000);
    add_excess_reserves(&s, 100);
    s.vault.withdraw_operator(&1);
}

#[test]
fn enforced_allows_operator_up_to_excess_when_fresh() {
    let s = setup_enforced();
    fund_vault(&s, 1_000_000); // net_custodied = reserves = 1_000_000
    add_excess_reserves(&s, 200_000); // reserves -> 1_200_000, floor still 1_000_000
    attest_solvent(&s, &[1_000_000], 1_200_000, 1_000_000, 1);
    s.vault.withdraw_operator(&200_000); // reserves_after = 1_000_000 == floor -> ok
    assert_eq!(s.vault.reserves(), 1_000_000);
    assert_eq!(s.vault.net_custodied(), 1_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // SolvencyBreach
fn enforced_blocks_operator_below_floor() {
    let s = setup_enforced();
    fund_vault(&s, 1_000_000);
    add_excess_reserves(&s, 200_000);
    attest_solvent(&s, &[1_000_000], 1_200_000, 1_000_000, 1);
    s.vault.withdraw_operator(&200_001); // reserves_after = 999_999 < floor -> breach
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")] // StaleAttestation
fn enforced_blocks_operator_when_stale() {
    let s = setup_enforced();
    fund_vault(&s, 1_000_000);
    add_excess_reserves(&s, 200_000);
    s.env.ledger().set_sequence_number(100);
    attest_solvent(&s, &[1_000_000], 1_200_000, 1_000_000, 1); // recorded at ledger 100
    s.env.ledger().set_sequence_number(100 + 17_281); // age 17_281 > max 17_280
    s.vault.withdraw_operator(&100);
}

#[test]
fn enforced_never_blocks_user_withdrawals() {
    // The whole point: staleness/solvency restrict only the operator. Users exit freely.
    let s = setup_enforced();
    fund_vault(&s, 1_000_000); // no attestation at all
    let user = Address::generate(&s.env);
    s.vault.withdraw_user(&user, &400_000);
    assert_eq!(s.token.balance(&user), 400_000);
    assert_eq!(s.vault.net_custodied(), 600_000);
}

#[test]
fn attestation_only_never_gates_operator() {
    let s = setup(); // AttestationOnly
    fund_vault(&s, 1_000);
    s.vault.withdraw_operator(&1_000); // can drain fully, no attestation required
    assert_eq!(s.vault.reserves(), 0);
}

#[test]
fn max_operator_withdrawable_reflects_floor_and_freshness() {
    let s = setup_enforced();
    fund_vault(&s, 1_000_000);
    add_excess_reserves(&s, 200_000);
    assert_eq!(s.vault.max_operator_withdrawable(), 0); // no attestation -> 0
    assert!(!s.vault.attestation_fresh());
    attest_solvent(&s, &[1_000_000], 1_200_000, 1_000_000, 1);
    assert!(s.vault.attestation_fresh());
    assert_eq!(s.vault.max_operator_withdrawable(), 200_000); // excess above floor
}

#[test]
fn set_mode_flips_enforcement() {
    let s = setup(); // AttestationOnly
    s.vault.set_mode(&Mode::Enforced);
    assert_eq!(s.vault.config().mode, Mode::Enforced);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // NoAttestation after flip
fn set_mode_to_enforced_then_operator_blocked() {
    let s = setup(); // AttestationOnly
    fund_vault(&s, 1_000);
    s.vault.set_mode(&Mode::Enforced);
    s.vault.withdraw_operator(&100); // now gated, no attestation -> blocked
}

#[test]
fn set_max_staleness_updates_config() {
    let s = setup();
    s.vault.set_max_staleness(&999u32);
    assert_eq!(s.vault.config().max_staleness_ledgers, 999);
}

// =================== F5: circuit-breaker + pro-rata exit ===================

#[test]
fn solvent_proof_keeps_healthy() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    assert_eq!(s.vault.status(), Status::Healthy);
    let j = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    s.vault.post_attestation(&j, &Bytes::from_array(&s.env, &[1u8; 8]));
    assert_eq!(s.vault.status(), Status::Healthy);
}

#[test]
fn solvent_proof_recovers_from_winddown() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    // trip into wind-down with an insolvent proof (L > reserves)
    let bad = make_journal(&s.env, &[1_000_001], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    s.vault.post_attestation(&bad, &Bytes::from_array(&s.env, &[1u8; 8]));
    assert_eq!(s.vault.status(), Status::WindDown);
    // a later solvent proof recovers to Healthy
    let good = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 2, DOMAIN);
    s.vault.post_attestation(&good, &Bytes::from_array(&s.env, &[1u8; 8]));
    assert_eq!(s.vault.status(), Status::Healthy);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")] // WindDownLocked
fn winddown_hard_locks_operator() {
    let s = setup(); // AttestationOnly — but wind-down locks regardless of mode
    fund_vault(&s, 1_000_000);
    let bad = make_journal(&s.env, &[1_000_001], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    s.vault.post_attestation(&bad, &Bytes::from_array(&s.env, &[1u8; 8]));
    s.vault.withdraw_operator(&1);
}

#[test]
fn winddown_user_withdrawal_is_pro_rata() {
    let s = setup();
    fund_vault(&s, 1_000_000); // nc = reserves = 1_000_000
    s.vault.withdraw_operator(&400_000); // AttestationOnly: drain to reserves = 600_000
    assert_eq!(s.vault.reserves(), 600_000);
    // insolvent proof: reserves 600k < L 1_000_000 → wind-down
    let bad = make_journal(&s.env, &[1_000_000], 600_000, 1_000_000, 10_000, 1, DOMAIN);
    s.vault.post_attestation(&bad, &Bytes::from_array(&s.env, &[1u8; 8]));
    assert_eq!(s.vault.status(), Status::WindDown);

    // user redeems a 100_000 claim → pro-rata 600k * 100k / 1M = 60_000
    let user = Address::generate(&s.env);
    s.vault.withdraw_user(&user, &100_000);
    assert_eq!(s.token.balance(&user), 60_000);
    assert_eq!(s.vault.net_custodied(), 900_000);
    // recovery ratio preserved for the rest: 540k / 900k == 600k / 1M
    assert_eq!(s.vault.reserves(), 540_000);
}

#[test]
fn check_breaker_trips_on_stale_enforced() {
    let s = setup_enforced();
    fund_vault(&s, 1_000_000);
    add_excess_reserves(&s, 1);
    s.env.ledger().set_sequence_number(100);
    attest_solvent(&s, &[1_000_000], 1_000_001, 1_000_000, 1);
    assert_eq!(s.vault.status(), Status::Healthy);
    s.env.ledger().set_sequence_number(100 + 17_281); // stale
    assert_eq!(s.vault.check_breaker(), Status::WindDown);
}

// =================== F3: composable solvency credential ===================

#[test]
fn require_fresh_attestation_passes_when_fresh_solvent() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    attest_solvent(&s, &[1_000_000], 1_000_000, 1_000_000, 1);
    s.vault.require_fresh_attestation(&17_280u32); // no panic
    let cred = s.vault.solvency_credential().unwrap();
    assert!(cred.solvent);
    assert_eq!(cred.ratio_bps, 10_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")] // CredentialUnavailable
fn require_fresh_attestation_traps_when_insolvent() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    let bad = make_journal(&s.env, &[1_000_001], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    s.vault.post_attestation(&bad, &Bytes::from_array(&s.env, &[1u8; 8]));
    s.vault.require_fresh_attestation(&17_280u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")] // CredentialUnavailable
fn require_fresh_attestation_traps_when_too_old() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    s.env.ledger().set_sequence_number(100);
    attest_solvent(&s, &[1_000_000], 1_000_000, 1_000_000, 1);
    s.env.ledger().set_sequence_number(100 + 60);
    s.vault.require_fresh_attestation(&50u32); // age 60 > 50
}

#[test]
#[should_panic(expected = "Error(Contract, #19)")] // CredentialUnavailable
fn require_fresh_attestation_traps_with_no_credential() {
    let s = setup();
    s.vault.require_fresh_attestation(&17_280u32);
}

// =================== F4: margin history feed ===================

#[test]
fn history_accumulates_per_attestation() {
    let s = setup();
    fund_vault(&s, 1_000_000);
    for epoch in 1..=3u32 {
        attest_solvent(&s, &[1_000_000], 1_000_000, 1_000_000, epoch);
    }
    let hist = s.vault.attestation_history();
    assert_eq!(hist.len(), 3);
    assert_eq!(hist.get(0).unwrap().epoch, 1);
    assert_eq!(hist.get(2).unwrap().epoch, 3);
    assert!(hist.get(2).unwrap().solvent);
}
