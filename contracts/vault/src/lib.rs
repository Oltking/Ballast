#![no_std]
//! # Ballast Vault
//!
//! A solvency-enforcing reserve vault for Stellar stablecoin custodians.
//!
//! A custodian holds pooled reserves of a **single** stablecoin (held as a
//! Stellar Asset Contract token) in this vault and keeps a *private* per-user
//! ledger off-chain. The vault:
//!
//! - custodies the reserve token and tracks `net_custodied` from on-chain flows
//!   (P1 — this phase);
//! - accepts zero-knowledge solvency attestations (`reserves >= liabilities`)
//!   verified via the Nethermind `stellar-risc0-verifier` (P3);
//! - **enforces** solvency by gating operator outflows on a fresh proof (P4).
//!
//! Reserves are read on-chain in-call (`reserve_token.balance(self)`), so there
//! is **no oracle** in the trustless core.
//!
//! ## Phase status
//! This file implements **P1: custody + flow accounting**. Attestation and
//! enforcement entry points are introduced in later phases; their config is
//! stored at init so the storage layout is stable.

use soroban_sdk::{
    contract, contractevent, contracterror, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env,
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
    InvalidAmount = 3,
    /// Withdrawing more than is currently custodied (would make `net_custodied` negative).
    InsufficientCustodied = 4,
    /// Arithmetic overflow on an accounting update.
    Overflow = 5,
    /// `max_staleness_ledgers` or `min_ratio_bps` out of range at init.
    InvalidConfig = 6,
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/// Enforcement tier. `AttestationOnly` records proofs but does not gate
/// outflows; `Enforced` gates operator outflows on a fresh proof (P4).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Mode {
    AttestationOnly = 0,
    Enforced = 1,
}

/// Immutable-ish configuration set at initialization. `image_id`, `mode`,
/// `max_staleness_ledgers` and `min_ratio_bps` are consumed from P3/P4 onward
/// but stored now to keep the layout stable. Admin setters arrive with the
/// phases that use them.
#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    pub operator: Address,
    /// SAC contract id of the single reserve stablecoin.
    pub reserve_token: Address,
    /// `stellar-risc0-verifier` router contract id (used from P3).
    pub verifier: Address,
    /// Pinned RISC Zero audit-guest image id (used from P3).
    pub image_id: BytesN<32>,
    pub mode: Mode,
    /// Freshness window for the enforced tier (used from P4).
    pub max_staleness_ledgers: u32,
    /// Minimum over-collateralization ratio in basis points; 10_000 = 100% (F2, used from P3).
    pub min_ratio_bps: u32,
}

// ----------------------------------------------------------------------------
// Events (sdk-26 `#[contractevent]`). `amount` is the flow; `net_custodied`
// is the running total after the flow.
// ----------------------------------------------------------------------------

#[contractevent]
#[derive(Clone)]
pub struct Deposit {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub net_custodied: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct WithdrawUser {
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub net_custodied: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct WithdrawOperator {
    pub amount: i128,
    pub net_custodied: i128,
}

#[contracttype]
pub enum DataKey {
    /// `Config`
    Config,
    /// `i128` — running Σ(deposits) − Σ(all outflows).
    NetCustodied,
    /// `u32` — increments per accepted attestation (anti-replay); 0 until P3.
    Epoch,
}

// ----------------------------------------------------------------------------
// Storage helpers
// ----------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280; // ~5s ledgers/day (confirm vs live close time)
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with(env, Error::NotInitialized))
}

fn net_custodied(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::NetCustodied)
        .unwrap_or(0)
}

fn set_net_custodied(env: &Env, v: i128) {
    env.storage().instance().set(&DataKey::NetCustodied, &v);
}

fn epoch(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Epoch).unwrap_or(0)
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
pub struct VaultContract;

#[contractimpl]
impl VaultContract {
    /// Initialize the vault. Idempotent-guarded.
    ///
    /// `min_ratio_bps` must be >= 10_000 (i.e. at least 1:1 backing).
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        operator: Address,
        reserve_token: Address,
        verifier: Address,
        image_id: BytesN<32>,
        mode: Mode,
        max_staleness_ledgers: u32,
        min_ratio_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic_with(&env, Error::AlreadyInitialized);
        }
        if min_ratio_bps < 10_000 || max_staleness_ledgers == 0 {
            panic_with(&env, Error::InvalidConfig);
        }
        let cfg = Config {
            admin,
            operator,
            reserve_token,
            verifier,
            image_id,
            mode,
            max_staleness_ledgers,
            min_ratio_bps,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::NetCustodied, &0i128);
        env.storage().instance().set(&DataKey::Epoch, &0u32);
        bump_instance(&env);
    }

    /// Deposit reserve tokens into the vault. Pulls `amount` of the reserve
    /// token from `from` and credits `net_custodied`.
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        require_positive(&env, amount);
        let cfg = get_config(&env);

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let nc = net_custodied(&env)
            .checked_add(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        set_net_custodied(&env, nc);
        bump_instance(&env);

        Deposit {
            from,
            amount,
            net_custodied: nc,
        }
        .publish(&env);
    }

    /// Process a customer redemption (a payout to a user).
    ///
    /// This reduces both reserves and the custodian's liabilities, so it is
    /// **never gated** by solvency/staleness — users must always be able to
    /// exit. In v1 normal operation, redemptions are operator-orchestrated
    /// (per-user balances live in the operator's private book); the trustless
    /// user-initiated exit is the WindDown pro-rata path (F5 / P7).
    pub fn withdraw_user(env: Env, to: Address, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        let nc = net_custodied(&env)
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        if nc < 0 {
            panic_with(&env, Error::InsufficientCustodied);
        }

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        set_net_custodied(&env, nc);
        bump_instance(&env);

        WithdrawUser {
            to,
            amount,
            net_custodied: nc,
        }
        .publish(&env);
    }

    /// Operator/fee/rehypothecation outflow — value leaving the vault that does
    /// **not** reduce liabilities. This is the dangerous direction and is
    /// **gated on a fresh solvency proof in P4**. In P1 it performs the
    /// transfer + accounting only (gating not yet wired).
    pub fn withdraw_operator(env: Env, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        // P4: gate on (mode == Enforced ⇒ fresh attestation AND reserves_after >= floor).

        let nc = net_custodied(&env)
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        if nc < 0 {
            panic_with(&env, Error::InsufficientCustodied);
        }

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &env.current_contract_address(),
            &cfg.operator,
            &amount,
        );
        set_net_custodied(&env, nc);
        bump_instance(&env);

        WithdrawOperator {
            amount,
            net_custodied: nc,
        }
        .publish(&env);
    }

    // ----- Views -----

    /// Live on-chain reserves: the vault's own balance of the reserve token.
    pub fn reserves(env: Env) -> i128 {
        let cfg = get_config(&env);
        token::TokenClient::new(&env, &cfg.reserve_token).balance(&env.current_contract_address())
    }

    pub fn net_custodied(env: Env) -> i128 {
        net_custodied(&env)
    }

    pub fn epoch(env: Env) -> u32 {
        epoch(&env)
    }

    pub fn config(env: Env) -> Config {
        get_config(&env)
    }
}

fn require_positive(env: &Env, amount: i128) {
    if amount <= 0 {
        panic_with(env, Error::InvalidAmount);
    }
}

#[cfg(test)]
mod test;
