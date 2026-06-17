#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

struct Setup<'a> {
    env: Env,
    vault: VaultContractClient<'a>,
    token: TokenClient<'a>,
    token_admin: StellarAssetClient<'a>,
    operator: Address,
    depositor: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let depositor = Address::generate(&env);

    // Reserve token: a Stellar Asset Contract (stand-in for the USDC SAC in tests).
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let reserve_token = sac.address();
    let token = TokenClient::new(&env, &reserve_token);
    let token_admin = StellarAssetClient::new(&env, &reserve_token);

    let verifier = Address::generate(&env); // unused in P1
    let image_id = BytesN::from_array(&env, &[0u8; 32]);

    let vault_id = env.register(VaultContract, ());
    let vault = VaultContractClient::new(&env, &vault_id);
    vault.initialize(
        &admin,
        &operator,
        &reserve_token,
        &verifier,
        &image_id,
        &Mode::AttestationOnly,
        &17_280u32,
        &10_000u32,
    );

    Setup {
        env,
        vault,
        token,
        token_admin,
        operator,
        depositor,
    }
}

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
    s.token_admin.mint(&s.depositor, &1_000);
    s.vault.deposit(&s.depositor, &1_000);

    let user = Address::generate(&s.env);
    s.vault.withdraw_user(&user, &250);

    assert_eq!(s.vault.net_custodied(), 750);
    assert_eq!(s.vault.reserves(), 750);
    assert_eq!(s.token.balance(&user), 250);
}

#[test]
fn operator_withdrawal_reduces_net_custodied() {
    let s = setup();
    s.token_admin.mint(&s.depositor, &1_000);
    s.vault.deposit(&s.depositor, &1_000);

    s.vault.withdraw_operator(&300);

    assert_eq!(s.vault.net_custodied(), 700);
    assert_eq!(s.vault.reserves(), 700);
    assert_eq!(s.token.balance(&s.operator), 300);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InsufficientCustodied
fn cannot_withdraw_more_than_custodied() {
    let s = setup();
    s.token_admin.mint(&s.depositor, &1_000);
    s.vault.deposit(&s.depositor, &500);
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
    s.vault.initialize(
        &any,
        &any,
        &any,
        &any,
        &image_id,
        &Mode::AttestationOnly,
        &17_280u32,
        &10_000u32,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")] // InvalidConfig (ratio < 100%)
fn rejects_subunitary_ratio() {
    let env = Env::default();
    env.mock_all_auths();
    let a = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(a.clone());
    let image_id = BytesN::from_array(&env, &[0u8; 32]);
    let vault_id = env.register(VaultContract, ());
    let vault = VaultContractClient::new(&env, &vault_id);
    vault.initialize(
        &a,
        &a,
        &sac.address(),
        &a,
        &image_id,
        &Mode::AttestationOnly,
        &17_280u32,
        &9_999u32,
    );
}
