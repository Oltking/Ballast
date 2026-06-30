#![no_std]
//! # Ballast Loan Book
//!
//! A custodian/lender's **on-chain loan ledger** — the chain-derived source of
//! truth for borrower credit history behind Ballast's ZK Credit Passport.
//!
//! Today the passport's per-borrower record (`repaid`, `defaults`) is
//! issuer-attested by hand. This contract makes it **chain-derived**: a lending
//! operator records every loan, repayment, and default on-chain, emitting an
//! event per action. The off-chain backend then *derives* each borrower's
//! `(repaid, defaults)` aggregate by counting those events — the same pattern
//! the vault uses to derive `net_custodied` from on-chain flows.
//!
//! The contract also keeps a live per-borrower aggregate in storage so the
//! numbers can be read directly (without replaying the log) when convenient.
//!
//! ## Trust note (per the project's non-negotiables)
//! These records are **operator-attested events**: the lender asserts that a
//! given loan/repayment/default happened. That is a labelled trust assumption —
//! the contract makes the *history* tamper-evident and publicly auditable (an
//! append-only event log under one operator key), not the off-chain lending
//! facts themselves. A passport predicate built on this anchors to a published
//! root of these on-chain records, so a borrower cannot fabricate their own.

use soroban_sdk::{
    contract, contractevent, contracterror, contractimpl, contracttype, panic_with_error, Address,
    Env,
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
    /// A loan/repayment amount that is not strictly positive.
    InvalidAmount = 3,
    /// Reserved for explicit authorization failures (operator/admin gating is
    /// enforced via `require_auth`, which traps as a host error).
    Unauthorized = 4,
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/// Per-borrower aggregate maintained on-chain from recorded flows. This is the
/// thing the ZK Credit Passport cares about: `repaid_count` and `default_count`
/// feed the borrower's credit record; `outstanding` is the live principal still
/// owed (disbursed minus repaid, saturating at zero).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BorrowerStats {
    pub outstanding: i128,
    pub repaid_count: u32,
    pub default_count: u32,
    pub disbursed_count: u32,
}

impl BorrowerStats {
    fn zero() -> Self {
        BorrowerStats {
            outstanding: 0,
            repaid_count: 0,
            default_count: 0,
            disbursed_count: 0,
        }
    }
}

#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    /// The lending operator authorized to record loan flows.
    pub operator: Address,
}

// ----------------------------------------------------------------------------
// Events — the backend derives per-borrower counts by reading this log. The
// running count after the action rides along so a consumer can checkpoint.
// ----------------------------------------------------------------------------

#[contractevent]
#[derive(Clone)]
pub struct Loaned {
    #[topic]
    pub borrower: Address,
    pub amount: i128,
    pub disbursed_count: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct Repaid {
    #[topic]
    pub borrower: Address,
    pub amount: i128,
    pub repaid_count: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct Defaulted {
    #[topic]
    pub borrower: Address,
    pub default_count: u32,
}

// ----------------------------------------------------------------------------
// Storage
// ----------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    /// `Config`
    Config,
    /// `BorrowerStats` keyed by borrower address.
    Stats(Address),
}

const DAY_IN_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;
// Borrower records are persistent (potentially many borrowers) and long-lived;
// keep them alive a generous window so the backend can read between refreshes.
const STATS_BUMP_AMOUNT: u32 = 60 * DAY_IN_LEDGERS;
const STATS_LIFETIME_THRESHOLD: u32 = STATS_BUMP_AMOUNT - DAY_IN_LEDGERS;

fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with(env, Error::NotInitialized))
}

fn get_stats(env: &Env, borrower: &Address) -> BorrowerStats {
    env.storage()
        .persistent()
        .get(&DataKey::Stats(borrower.clone()))
        .unwrap_or_else(BorrowerStats::zero)
}

fn set_stats(env: &Env, borrower: &Address, stats: &BorrowerStats) {
    let key = DataKey::Stats(borrower.clone());
    env.storage().persistent().set(&key, stats);
    env.storage()
        .persistent()
        .extend_ttl(&key, STATS_LIFETIME_THRESHOLD, STATS_BUMP_AMOUNT);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn panic_with(env: &Env, e: Error) -> ! {
    panic_with_error!(env, e)
}

fn require_positive(env: &Env, amount: i128) {
    if amount <= 0 {
        panic_with(env, Error::InvalidAmount);
    }
}

// ----------------------------------------------------------------------------
// Contract
// ----------------------------------------------------------------------------

#[contract]
pub struct LoanBookContract;

#[contractimpl]
impl LoanBookContract {
    /// Initialize the loan book. Idempotent-guarded.
    pub fn initialize(env: Env, admin: Address, operator: Address) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with(&env, Error::AlreadyInitialized);
        }
        env.storage()
            .instance()
            .set(&DataKey::Config, &Config { admin, operator });
        bump_instance(&env);
    }

    /// Record a new loan to `borrower`: increments `disbursed_count` and adds
    /// `amount` to `outstanding`. Operator-gated; `amount` must be positive.
    pub fn disburse(env: Env, borrower: Address, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        let mut stats = get_stats(&env, &borrower);
        stats.disbursed_count = stats.disbursed_count.saturating_add(1);
        stats.outstanding = stats.outstanding.saturating_add(amount);
        set_stats(&env, &borrower, &stats);
        bump_instance(&env);

        Loaned {
            borrower,
            amount,
            disbursed_count: stats.disbursed_count,
        }
        .publish(&env);
    }

    /// Record a (full-loan) repayment from `borrower`: increments `repaid_count`
    /// and subtracts `amount` from `outstanding`, saturating at zero (interest
    /// accrual / rounding can make a payment exceed tracked principal).
    /// Operator-gated; `amount` must be positive.
    pub fn repay(env: Env, borrower: Address, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        let mut stats = get_stats(&env, &borrower);
        stats.repaid_count = stats.repaid_count.saturating_add(1);
        stats.outstanding = (stats.outstanding - amount).max(0);
        set_stats(&env, &borrower, &stats);
        bump_instance(&env);

        Repaid {
            borrower,
            amount,
            repaid_count: stats.repaid_count,
        }
        .publish(&env);
    }

    /// Mark a loan to `borrower` as defaulted: increments `default_count`.
    /// Operator-gated. (`outstanding` is left as-is; a default does not discharge
    /// the debt, it records a missed obligation for the credit history.)
    pub fn mark_default(env: Env, borrower: Address) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();

        let mut stats = get_stats(&env, &borrower);
        stats.default_count = stats.default_count.saturating_add(1);
        set_stats(&env, &borrower, &stats);
        bump_instance(&env);

        Defaulted {
            borrower,
            default_count: stats.default_count,
        }
        .publish(&env);
    }

    // ----- Admin -----

    /// Rotate the lending operator. Admin-only.
    pub fn set_operator(env: Env, operator: Address) {
        let mut cfg = get_config(&env);
        cfg.admin.require_auth();
        cfg.operator = operator;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    // ----- Views -----

    /// The borrower's aggregate (zeros for an unknown borrower).
    pub fn stats(env: Env, borrower: Address) -> BorrowerStats {
        get_stats(&env, &borrower)
    }

    pub fn config(env: Env) -> Config {
        get_config(&env)
    }
}

#[cfg(test)]
mod test;
