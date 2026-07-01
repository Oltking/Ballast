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
// pool at the real Nethermind risc0-verifier router).
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
    pool: PoolContractClient<'a>,
    token: TokenClient<'a>,
    token_admin: StellarAssetClient<'a>,
    operator: Address,
    lender: Address,
}

/// Default setup (AttestationOnly) with a passing verifier double.
fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    setup_with_verifier_mode(env, verifier, Mode::AttestationOnly)
}

/// Enforced-mode setup with a passing verifier double (for gate tests).
fn setup_enforced() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    setup_with_verifier_mode(env, verifier, Mode::Enforced)
}

fn setup_with_verifier_mode(env: Env, verifier: Address, mode: Mode) -> Setup<'static> {
    setup_with_verifier_ratio(env, verifier, mode, 10_000)
}

fn setup_with_verifier_ratio(
    env: Env,
    verifier: Address,
    mode: Mode,
    min_ratio_bps: u32,
) -> Setup<'static> {
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let lender = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let reserve_token = sac.address();
    let token = TokenClient::new(&env, &reserve_token);
    let token_admin = StellarAssetClient::new(&env, &reserve_token);
    let image_id = BytesN::from_array(&env, &[0u8; 32]);
    let domain = BytesN::from_array(&env, &DOMAIN);
    let pool_id = env.register(PoolContract, ());
    let pool = PoolContractClient::new(&env, &pool_id);
    pool.initialize(
        &admin, &operator, &reserve_token, &verifier, &image_id, &mode, &17_280u32,
        &min_ratio_bps, &domain,
    );
    Setup { env, pool, token, token_admin, operator, lender }
}

/// Build a 107-byte journal using the *guest's* packer so the contract parser
/// and the guest can never drift. For the pool, `reserves` should be passed the
/// pool's `assets()` and `net_custodied` its `pooled`.
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

/// Post a solvent attestation binding reserves=assets, net_custodied=pooled.
fn attest(s: &Setup, leaves: &[u64], assets: u64, pooled: u64, epoch: u32) {
    let journal = make_journal(&s.env, leaves, assets, pooled, 10_000, epoch, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&journal, &seal);
}

/// Seed the pool with lender deposits.
fn fund(s: &Setup, amount: i128) {
    s.token_admin.mint(&s.lender, &amount);
    s.pool.lender_deposit(&s.lender, &amount);
}

// =================== lender flows ===================

#[test]
fn lender_deposit_raises_pooled_and_cash() {
    let s = setup();
    s.token_admin.mint(&s.lender, &1_000);
    s.pool.lender_deposit(&s.lender, &600);
    assert_eq!(s.pool.pooled(), 600);
    assert_eq!(s.pool.cash(), 600);
    assert_eq!(s.pool.assets(), 600);
    assert_eq!(s.pool.outstanding(), 0);
    assert_eq!(s.token.balance(&s.lender), 400);
    assert_eq!(s.pool.epoch(), 0);
}

#[test]
fn lender_withdraw_reduces_pooled_and_cash() {
    let s = setup();
    fund(&s, 1_000);
    let to = Address::generate(&s.env);
    s.pool.lender_withdraw(&to, &250);
    assert_eq!(s.pool.pooled(), 750);
    assert_eq!(s.pool.cash(), 750);
    assert_eq!(s.token.balance(&to), 250);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // InsufficientLiquidity
fn lender_withdraw_reverts_when_cash_lent_out() {
    let s = setup();
    fund(&s, 1_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &800); // cash now 200, outstanding 800
    let to = Address::generate(&s.env);
    s.pool.lender_withdraw(&to, &300); // only 200 cash available
}

#[test]
fn lender_withdraw_up_to_available_cash_succeeds() {
    let s = setup();
    fund(&s, 1_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &800); // cash 200
    let to = Address::generate(&s.env);
    s.pool.lender_withdraw(&to, &200); // exactly available
    assert_eq!(s.pool.cash(), 0);
    assert_eq!(s.pool.pooled(), 800);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidAmount
fn rejects_nonpositive_deposit() {
    let s = setup();
    s.pool.lender_deposit(&s.lender, &0);
}

// =================== borrow / repay ===================

#[test]
fn borrow_moves_cash_to_outstanding_assets_unchanged() {
    let s = setup();
    fund(&s, 1_000);
    let assets_before = s.pool.assets();
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400);
    assert_eq!(s.pool.cash(), 600);
    assert_eq!(s.pool.outstanding(), 400);
    assert_eq!(s.pool.assets(), assets_before); // 1_000, unchanged
    assert_eq!(s.pool.pooled(), 1_000); // claims floor unchanged by lending
    assert_eq!(s.token.balance(&borrower), 400);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")] // InsufficientLiquidity
fn borrow_cannot_exceed_cash() {
    let s = setup();
    fund(&s, 500);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &501);
}

#[test]
fn repay_raises_cash_lowers_outstanding() {
    let s = setup();
    fund(&s, 1_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400); // cash 600, outstanding 400
    // borrower repays principal
    s.pool.repay(&borrower, &400);
    assert_eq!(s.pool.cash(), 1_000);
    assert_eq!(s.pool.outstanding(), 0);
    assert_eq!(s.pool.assets(), 1_000);
    assert_eq!(s.pool.surplus(), 0);
}

#[test]
fn excess_repayment_becomes_surplus() {
    let s = setup();
    fund(&s, 1_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400); // outstanding 400, cash 600
    s.token_admin.mint(&borrower, &50); // interest
    s.pool.repay(&borrower, &450); // pays 400 principal + 50 interest
    assert_eq!(s.pool.outstanding(), 0); // clamped at zero
    assert_eq!(s.pool.cash(), 1_050);
    assert_eq!(s.pool.assets(), 1_050);
    assert_eq!(s.pool.pooled(), 1_000);
    assert_eq!(s.pool.surplus(), 50); // yield buffer
}

// =================== attestation binding ===================

#[test]
fn accepts_solvent_attestation_bound_to_assets() {
    let s = setup();
    fund(&s, 1_000_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400_000); // assets still 1_000_000, cash 600_000
    assert_eq!(s.pool.assets(), 1_000_000);

    // L = pooled = 1_000_000, assets = 1_000_000 → solvent at 100%.
    attest(&s, &[600_000, 400_000], 1_000_000, 1_000_000, 1);

    assert_eq!(s.pool.epoch(), 1);
    let att = s.pool.latest_attestation().unwrap();
    assert!(att.solvent);
    assert_eq!(att.reserves, 1_000_000); // bound to assets()
    assert_eq!(att.net_custodied, 1_000_000); // bound to pooled
    assert_eq!(s.pool.status(), Status::Healthy);
}

#[test]
#[should_panic(expected = "Error(Contract, #9)")] // ReservesMismatch
fn rejects_reserves_not_equal_assets() {
    let s = setup();
    fund(&s, 1_000_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400_000); // assets = 1_000_000
    // journal claims reserves = 600_000 (only cash), but assets() = 1_000_000
    let journal = make_journal(&s.env, &[600_000], 600_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")] // NetCustodiedMismatch
fn rejects_net_custodied_not_equal_pooled() {
    let s = setup();
    fund(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 999_999, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")] // EpochMismatch (replay)
fn rejects_replayed_attestation() {
    let s = setup();
    fund(&s, 1_000_000);
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 1);
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 1); // stored epoch now 1, expects 2
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")] // DomainMismatch
fn rejects_wrong_domain() {
    let s = setup();
    fund(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, [1u8; 32]);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")] // RatioMismatch
fn rejects_ratio_mismatch() {
    let s = setup();
    fund(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 9_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&journal, &seal);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // BadJournal
fn rejects_malformed_journal_length() {
    let s = setup();
    fund(&s, 1_000_000);
    let short = Bytes::from_array(&s.env, &[0u8; 10]);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&short, &seal);
}

#[test]
#[should_panic] // verifier traps on a bad proof
fn rejects_when_verifier_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let reject = env.register(RejectVerifier, ());
    let s = setup_with_verifier_mode(env, reject, Mode::AttestationOnly);
    fund(&s, 1_000_000);
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 10_000, 1, DOMAIN);
    let seal = Bytes::from_array(&s.env, &[1u8; 8]);
    s.pool.post_attestation(&journal, &seal);
}

#[test]
fn ledger_is_recorded_in_attestation() {
    let s = setup();
    fund(&s, 1_000_000);
    s.env.ledger().set_sequence_number(12345);
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 1);
    assert_eq!(s.pool.latest_attestation().unwrap().ledger, 12345);
}

// =================== enforcement gate on borrow ===================

#[test]
#[should_panic(expected = "Error(Contract, #12)")] // NoAttestation
fn enforced_blocks_borrow_without_attestation() {
    let s = setup_enforced();
    fund(&s, 1_000_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &1);
}

#[test]
fn enforced_allows_borrow_with_fresh_solvent_attestation() {
    let s = setup_enforced();
    fund(&s, 1_000_000);
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 1);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &300_000);
    assert_eq!(s.pool.outstanding(), 300_000);
    assert_eq!(s.pool.cash(), 700_000);
    assert_eq!(s.pool.assets(), 1_000_000); // unchanged
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")] // StaleAttestation
fn enforced_blocks_borrow_when_stale() {
    let s = setup_enforced();
    fund(&s, 1_000_000);
    s.env.ledger().set_sequence_number(100);
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 1); // recorded at ledger 100
    s.env.ledger().set_sequence_number(100 + 17_281); // age 17_281 > max 17_280
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &1);
}

#[test]
fn attestation_only_never_gates_borrow() {
    let s = setup(); // AttestationOnly
    fund(&s, 1_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &1_000); // no attestation required
    assert_eq!(s.pool.outstanding(), 1_000);
    assert_eq!(s.pool.cash(), 0);
}

#[test]
fn enforced_never_blocks_lender_withdrawals() {
    // Staleness/solvency restrict only borrows. Lenders exit freely against cash.
    let s = setup_enforced();
    fund(&s, 1_000_000); // no attestation at all
    let to = Address::generate(&s.env);
    s.pool.lender_withdraw(&to, &400_000);
    assert_eq!(s.token.balance(&to), 400_000);
    assert_eq!(s.pool.pooled(), 600_000);
}

// =================== write-off drives insolvency / wind-down ===================

#[test]
fn write_off_drives_insolvent_attestation_and_winddown() {
    let s = setup();
    fund(&s, 1_000_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400_000); // assets 1_000_000
    // borrower defaults: write off 400_000 with no cash recovery.
    s.pool.write_off(&400_000);
    assert_eq!(s.pool.outstanding(), 0);
    assert_eq!(s.pool.cash(), 600_000);
    assert_eq!(s.pool.assets(), 600_000); // dropped below pooled 1_000_000
    assert_eq!(s.pool.surplus(), -400_000);

    // A proof over the true book (L = pooled = 1_000_000) vs assets 600_000 is
    // INSOLVENT → recorded, trips wind-down.
    attest(&s, &[1_000_000], 600_000, 1_000_000, 1);
    let att = s.pool.latest_attestation().unwrap();
    assert!(!att.solvent);
    assert!(!att.reserves_checked); // assets 600k < L 1M
    assert_eq!(s.pool.status(), Status::WindDown);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")] // Insolvent
fn enforced_blocks_borrow_after_winddown() {
    let s = setup_enforced();
    fund(&s, 1_000_000);
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 1); // solvent, enables borrow
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400_000); // assets still 1M
    s.pool.write_off(&400_000); // assets 600k < pooled 1M
    attest(&s, &[1_000_000], 600_000, 1_000_000, 2); // insolvent → WindDown
    assert_eq!(s.pool.status(), Status::WindDown);
    s.pool.borrow(&borrower, &1); // blocked
}

#[test]
fn solvent_proof_recovers_from_winddown() {
    let s = setup();
    fund(&s, 1_000_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400_000);
    s.pool.write_off(&400_000); // assets 600k
    attest(&s, &[1_000_000], 600_000, 1_000_000, 1); // insolvent
    assert_eq!(s.pool.status(), Status::WindDown);
    // operator injects capital: cash back up to cover claims
    s.token_admin.mint(&s.pool.address, &400_000); // assets -> 1_000_000
    attest(&s, &[1_000_000], 1_000_000, 1_000_000, 2); // solvent
    assert_eq!(s.pool.status(), Status::Healthy);
}

// =================== F2 ratio (contract-level) ===================

#[test]
fn ratio_buffer_forces_insolvent_at_1to1() {
    let env = Env::default();
    env.mock_all_auths();
    let verifier = env.register(AcceptVerifier, ());
    let s = setup_with_verifier_ratio(env, verifier, Mode::AttestationOnly, 12_000);
    fund(&s, 1_000_000); // assets = pooled = 1_000_000
    let journal = make_journal(&s.env, &[1_000_000], 1_000_000, 1_000_000, 12_000, 1, DOMAIN);
    s.pool.post_attestation(&journal, &Bytes::from_array(&s.env, &[1u8; 8]));
    let att = s.pool.latest_attestation().unwrap();
    assert!(!att.reserves_checked, "1:1 must fail the 120% ratio check");
    assert!(!att.solvent);
    assert_eq!(s.pool.status(), Status::WindDown);
}

// =================== credential / views ===================

#[test]
fn solvency_credential_reports_margin_as_surplus() {
    let s = setup();
    fund(&s, 1_000_000);
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &400_000);
    s.token_admin.mint(&borrower, &50_000);
    s.pool.repay(&borrower, &450_000); // 400k principal + 50k interest surplus
    attest(&s, &[1_000_000], 1_050_000, 1_000_000, 1);
    let cred = s.pool.solvency_credential().unwrap();
    assert!(cred.solvent);
    assert_eq!(cred.ratio_bps, 10_000);
    assert_eq!(cred.margin, 50_000); // assets - pooled = surplus
    assert!(cred.fresh);
    assert_eq!(cred.status, Status::Healthy);
}

// =================== init / admin / auth ===================

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // AlreadyInitialized
fn cannot_initialize_twice() {
    let s = setup();
    let any = Address::generate(&s.env);
    let image_id = BytesN::from_array(&s.env, &[0u8; 32]);
    let domain = BytesN::from_array(&s.env, &DOMAIN);
    s.pool.initialize(
        &any, &any, &any, &any, &image_id, &Mode::AttestationOnly, &17_280u32, &10_000u32, &domain,
    );
}

#[test]
fn set_mode_flips_enforcement() {
    let s = setup();
    s.pool.set_mode(&Mode::Enforced);
    assert_eq!(s.pool.config().mode, Mode::Enforced);
}

#[test]
fn set_image_id_updates_pinned_guest() {
    let s = setup();
    let new_id = BytesN::from_array(&s.env, &[7u8; 32]);
    s.pool.set_image_id(&new_id);
    assert_eq!(s.pool.config().image_id, new_id);
}

// Build a pool WITHOUT mocking auths, so require_auth() actually guards the call.
fn setup_no_mocked_auth() -> Setup<'static> {
    let env = Env::default();
    let verifier = env.register(AcceptVerifier, ());
    setup_with_verifier_mode(env, verifier, Mode::AttestationOnly)
}

#[test]
#[should_panic] // operator auth required (runs before any balance check)
fn borrow_requires_operator_auth() {
    let s = setup_no_mocked_auth();
    let borrower = Address::generate(&s.env);
    s.pool.borrow(&borrower, &1);
}

#[test]
#[should_panic] // operator auth required
fn lender_withdraw_requires_operator_auth() {
    let s = setup_no_mocked_auth();
    let to = Address::generate(&s.env);
    s.pool.lender_withdraw(&to, &1);
}

#[test]
#[should_panic] // admin auth required
fn set_mode_requires_admin_auth() {
    let s = setup_no_mocked_auth();
    s.pool.set_mode(&Mode::Enforced);
}
