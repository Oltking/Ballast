#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env,
};

struct Setup<'a> {
    env: Env,
    admin: Address,
    operator: Address,
    book: LoanBookContractClient<'a>,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let id = env.register(LoanBookContract, ());
    let book = LoanBookContractClient::new(&env, &id);
    book.initialize(&admin, &operator);
    Setup {
        env,
        admin,
        operator,
        book,
    }
}

// =================== init ===================

#[test]
fn initialize_sets_config() {
    let s = setup();
    let cfg = s.book.config();
    assert_eq!(cfg.admin, s.admin);
    assert_eq!(cfg.operator, s.operator);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // AlreadyInitialized
fn cannot_initialize_twice() {
    let s = setup();
    s.book.initialize(&s.admin, &s.operator);
}

// =================== disburse ===================

#[test]
fn disburse_updates_stats_and_event() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &1_000);

    // A Loaned event was emitted by the disburse call (check before any view
    // call — `events().all()` only reflects the most recent invocation).
    let events = s.env.events().all();
    assert_eq!(events.events().len(), 1);

    let st = s.book.stats(&borrower);
    assert_eq!(st.disbursed_count, 1);
    assert_eq!(st.outstanding, 1_000);
    assert_eq!(st.repaid_count, 0);
    assert_eq!(st.default_count, 0);
}

#[test]
fn multiple_disburse_accumulates() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &500);
    s.book.disburse(&borrower, &300);
    let st = s.book.stats(&borrower);
    assert_eq!(st.disbursed_count, 2);
    assert_eq!(st.outstanding, 800);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidAmount
fn disburse_rejects_zero() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidAmount
fn disburse_rejects_negative() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &-5);
}

// =================== repay ===================

#[test]
fn repay_updates_stats() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &1_000);
    s.book.repay(&borrower, &400);
    let st = s.book.stats(&borrower);
    assert_eq!(st.repaid_count, 1);
    assert_eq!(st.outstanding, 600);
    assert_eq!(st.disbursed_count, 1);
}

#[test]
fn repay_saturates_outstanding_at_zero() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &1_000);
    s.book.repay(&borrower, &5_000); // over-repay (e.g. interest)
    let st = s.book.stats(&borrower);
    assert_eq!(st.outstanding, 0);
    assert_eq!(st.repaid_count, 1);
}

#[test]
fn repay_counts_increment_independently() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &1_000);
    s.book.repay(&borrower, &100);
    s.book.repay(&borrower, &100);
    s.book.repay(&borrower, &100);
    let st = s.book.stats(&borrower);
    assert_eq!(st.repaid_count, 3);
    assert_eq!(st.outstanding, 700);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // InvalidAmount
fn repay_rejects_zero() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.repay(&borrower, &0);
}

// =================== mark_default ===================

#[test]
fn mark_default_increments_count() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &1_000);
    s.book.mark_default(&borrower);
    let st = s.book.stats(&borrower);
    assert_eq!(st.default_count, 1);
    // default does not discharge outstanding principal
    assert_eq!(st.outstanding, 1_000);
}

#[test]
fn mark_default_accumulates() {
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.mark_default(&borrower);
    s.book.mark_default(&borrower);
    assert_eq!(s.book.stats(&borrower).default_count, 2);
}

// =================== independence / unknown ===================

#[test]
fn stats_zero_for_unknown_borrower() {
    let s = setup();
    let unknown = Address::generate(&s.env);
    let st = s.book.stats(&unknown);
    assert_eq!(st.outstanding, 0);
    assert_eq!(st.repaid_count, 0);
    assert_eq!(st.default_count, 0);
    assert_eq!(st.disbursed_count, 0);
}

#[test]
fn distinct_borrowers_are_independent() {
    let s = setup();
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    s.book.disburse(&a, &1_000);
    s.book.repay(&a, &200);
    s.book.disburse(&b, &50);
    s.book.mark_default(&b);

    let sa = s.book.stats(&a);
    assert_eq!(sa.disbursed_count, 1);
    assert_eq!(sa.repaid_count, 1);
    assert_eq!(sa.outstanding, 800);
    assert_eq!(sa.default_count, 0);

    let sb = s.book.stats(&b);
    assert_eq!(sb.disbursed_count, 1);
    assert_eq!(sb.outstanding, 50);
    assert_eq!(sb.default_count, 1);
    assert_eq!(sb.repaid_count, 0);
}

#[test]
fn full_lifecycle_builds_credit_record() {
    // A good borrower: repays everything across several loans, no defaults.
    let s = setup();
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &1_000);
    s.book.repay(&borrower, &1_000);
    s.book.disburse(&borrower, &2_000);
    s.book.repay(&borrower, &2_000);
    let st = s.book.stats(&borrower);
    assert_eq!(st.disbursed_count, 2);
    assert_eq!(st.repaid_count, 2);
    assert_eq!(st.default_count, 0);
    assert_eq!(st.outstanding, 0);
}

// =================== events ===================

#[test]
fn events_emitted_per_action() {
    // `events().all()` reflects only the most recent invocation, so assert each
    // emitting action publishes exactly one event of its own.
    let s = setup();
    let borrower = Address::generate(&s.env);

    s.book.disburse(&borrower, &1_000);
    assert_eq!(s.env.events().all().events().len(), 1);

    s.book.repay(&borrower, &400);
    assert_eq!(s.env.events().all().events().len(), 1);

    s.book.mark_default(&borrower);
    assert_eq!(s.env.events().all().events().len(), 1);
}

// =================== admin: set_operator ===================

#[test]
fn set_operator_rotates() {
    let s = setup();
    let new_op = Address::generate(&s.env);
    s.book.set_operator(&new_op);
    assert_eq!(s.book.config().operator, new_op);

    // The new operator can record; works under mock_all_auths.
    let borrower = Address::generate(&s.env);
    s.book.disburse(&borrower, &10);
    assert_eq!(s.book.stats(&borrower).outstanding, 10);
}

// =================== auth (no mock_all_auths) ===================

#[test]
#[should_panic] // operator auth required
fn disburse_requires_operator_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let id = env.register(LoanBookContract, ());
    let book = LoanBookContractClient::new(&env, &id);
    env.mock_all_auths();
    book.initialize(&admin, &operator);
    env.set_auths(&[]); // drop mocked auths
    book.disburse(&Address::generate(&env), &100);
}

#[test]
#[should_panic] // operator auth required
fn repay_requires_operator_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let id = env.register(LoanBookContract, ());
    let book = LoanBookContractClient::new(&env, &id);
    env.mock_all_auths();
    book.initialize(&admin, &operator);
    env.set_auths(&[]);
    book.repay(&Address::generate(&env), &100);
}

#[test]
#[should_panic] // operator auth required
fn mark_default_requires_operator_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let id = env.register(LoanBookContract, ());
    let book = LoanBookContractClient::new(&env, &id);
    env.mock_all_auths();
    book.initialize(&admin, &operator);
    env.set_auths(&[]);
    book.mark_default(&Address::generate(&env));
}

#[test]
#[should_panic] // admin auth required
fn set_operator_requires_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    let id = env.register(LoanBookContract, ());
    let book = LoanBookContractClient::new(&env, &id);
    env.mock_all_auths();
    book.initialize(&admin, &operator);
    env.set_auths(&[]);
    book.set_operator(&Address::generate(&env));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotInitialized
fn config_before_init_traps() {
    let env = Env::default();
    let id = env.register(LoanBookContract, ());
    let book = LoanBookContractClient::new(&env, &id);
    book.config();
}
