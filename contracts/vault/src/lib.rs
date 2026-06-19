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
    contract, contractclient, contractevent, contracterror, contractimpl, contracttype,
    panic_with_error, token, Address, Bytes, BytesN, Env,
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
    /// Journal byte length doesn't match the expected layout.
    BadJournal = 7,
    /// Journal `domain` != this vault (cross-contract proof reuse).
    DomainMismatch = 8,
    /// Journal `epoch` != stored epoch + 1 (stale/replayed proof).
    EpochMismatch = 9,
    /// Journal `reserves` != the vault's live on-chain reserve balance.
    ReservesMismatch = 10,
    /// Journal `net_custodied` != the vault's on-chain accounting.
    NetCustodiedMismatch = 11,
    /// Journal `ratio_bps` != the vault's configured minimum ratio.
    RatioMismatch = 12,
    /// The proof's verdict is INSOLVENT (or a predicate failed).
    Insolvent = 13,
    /// Operator outflow attempted in Enforced mode with no attestation on record.
    NoAttestation = 14,
    /// Operator outflow blocked: latest attestation older than `max_staleness_ledgers`.
    StaleAttestation = 15,
    /// Operator outflow would push reserves below the custodied floor.
    SolvencyBreach = 16,
    /// Operator outflow exceeds the vault's live reserve balance.
    InsufficientReserves = 17,
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
    /// Domain-separation tag bound into every proof journal (set to this vault's
    /// contract id). Prevents replaying a proof against a different vault.
    pub domain: BytesN<32>,
}

// ----------------------------------------------------------------------------
// RISC Zero verifier (router) client — matches NethermindEth/stellar-risc0-verifier.
// `verify` traps if the seal is not a valid Groth16 proof for (image_id, journal).
// ----------------------------------------------------------------------------

#[contractclient(name = "VerifierClient")]
pub trait RiscZeroVerifierRouter {
    fn verify(env: Env, seal: Bytes, image_id: BytesN<32>, journal: BytesN<32>);
}

/// Decoded solvency journal (fixed 107-byte layout, big-endian), mirroring
/// `ballast-core::pack_journal`:
/// `root[32] | domain[32] | reserves(i128)[16] | net_custodied(i128)[16] |
///  ratio_bps(u32)[4] | epoch(u32)[4] | reserves_checked | floor_checked | solvent`.
#[contracttype]
#[derive(Clone)]
pub struct Attestation {
    pub liabilities_root: BytesN<32>,
    pub reserves: i128,
    pub net_custodied: i128,
    pub ratio_bps: u32,
    pub epoch: u32,
    /// Ledger sequence at which this attestation was recorded.
    pub ledger: u32,
    pub reserves_checked: bool,
    pub floor_checked: bool,
    pub solvent: bool,
}

/// Expected journal byte length (see `Attestation` layout).
const JOURNAL_LEN: u32 = 32 + 32 + 16 + 16 + 4 + 4 + 1 + 1 + 1; // 107

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

#[contractevent]
#[derive(Clone)]
pub struct Attested {
    pub epoch: u32,
    pub ledger: u32,
    pub solvent: bool,
    pub ratio_bps: u32,
}

#[contracttype]
pub enum DataKey {
    /// `Config`
    Config,
    /// `i128` — custodied floor = Σ(deposits) − Σ(user redemptions). Operator
    /// outflows do **not** reduce it (they don't discharge user liabilities), so
    /// it stays a valid lower bound on `L` for the enforcement gate.
    NetCustodied,
    /// `u32` — increments per accepted attestation (anti-replay).
    Epoch,
    /// `Attestation` — the most recent accepted attestation.
    LatestAttestation,
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

/// True iff an attestation is on record and within `max_staleness_ledgers`.
fn is_fresh(env: &Env, cfg: &Config) -> bool {
    match env
        .storage()
        .instance()
        .get::<_, Attestation>(&DataKey::LatestAttestation)
    {
        Some(att) => env.ledger().sequence().saturating_sub(att.ledger) <= cfg.max_staleness_ledgers,
        None => false,
    }
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
        domain: BytesN<32>,
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
            domain,
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
    /// **not** reduce user liabilities (so it never changes `net_custodied`).
    /// This is the dangerous direction and is **gated** in `Enforced` mode (P4):
    ///
    /// - a solvency attestation must be on record (`NoAttestation` otherwise),
    /// - it must be **fresh** — within `max_staleness_ledgers` (`StaleAttestation`
    ///   otherwise; a stale proof locks the operator, never users),
    /// - and the outflow must keep `reserves_after >= net_custodied` (the
    ///   custodied floor; `SolvencyBreach` otherwise).
    ///
    /// In `AttestationOnly` mode the outflow is recorded but never gated.
    ///
    /// Because `L` is private, the floor is `net_custodied` (proven `L >= net_custodied`),
    /// not `L` itself: the operator can never drain reserves below the on-chain
    /// custodied principal, and full `reserves >= L` is re-proven every staleness
    /// window. The `net_custodied..L` gap (accrued interest) is the stated,
    /// bounded trust window.
    pub fn withdraw_operator(env: Env, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        let live_reserves = token::TokenClient::new(&env, &cfg.reserve_token)
            .balance(&env.current_contract_address());
        let reserves_after = live_reserves
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        if reserves_after < 0 {
            panic_with(&env, Error::InsufficientReserves);
        }

        // P4 enforcement gate (operator-only; users are never gated).
        if cfg.mode == Mode::Enforced {
            let att = env
                .storage()
                .instance()
                .get::<_, Attestation>(&DataKey::LatestAttestation)
                .unwrap_or_else(|| panic_with(&env, Error::NoAttestation));
            let age = env.ledger().sequence().saturating_sub(att.ledger);
            if age > cfg.max_staleness_ledgers {
                panic_with(&env, Error::StaleAttestation);
            }
            if reserves_after < net_custodied(&env) {
                panic_with(&env, Error::SolvencyBreach);
            }
        }

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &env.current_contract_address(),
            &cfg.operator,
            &amount,
        );
        bump_instance(&env);

        // `net_custodied` is unchanged by an operator outflow.
        WithdrawOperator {
            amount,
            net_custodied: net_custodied(&env),
        }
        .publish(&env);
    }

    // ----- Admin setters (guarded; let the operator flip tiers / refresh config) -----

    /// Switch enforcement tier. Lets an operator run `AttestationOnly` first,
    /// then lock the vault by flipping to `Enforced`.
    pub fn set_mode(env: Env, mode: Mode) {
        let mut cfg = get_config(&env);
        cfg.admin.require_auth();
        cfg.mode = mode;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Update the freshness window (ledgers).
    pub fn set_max_staleness(env: Env, max_staleness_ledgers: u32) {
        let mut cfg = get_config(&env);
        cfg.admin.require_auth();
        if max_staleness_ledgers == 0 {
            panic_with(&env, Error::InvalidConfig);
        }
        cfg.max_staleness_ledgers = max_staleness_ledgers;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Re-pin the trusted RISC Zero guest image id (e.g. after a guest upgrade).
    pub fn set_image_id(env: Env, image_id: BytesN<32>) {
        let mut cfg = get_config(&env);
        cfg.admin.require_auth();
        cfg.image_id = image_id;
        env.storage().instance().set(&DataKey::Config, &cfg);
        bump_instance(&env);
    }

    /// Verify a RISC Zero solvency proof and record the attestation.
    ///
    /// Flow: hash the journal → verify the Groth16 seal via the router against
    /// the pinned `image_id` (traps on a bad proof) → parse the journal → bind
    /// every public value to live chain state (domain, epoch, reserves,
    /// net_custodied, ratio) → require SOLVENT → record + bump epoch.
    ///
    /// `L` (total liabilities) is never in the journal and is never learned here.
    pub fn post_attestation(env: Env, journal: Bytes, seal: Bytes) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();

        // 1. Cryptographic verification: the seal must prove this exact journal
        //    was produced by the pinned guest program. Traps on failure.
        let journal_digest: BytesN<32> = env.crypto().sha256(&journal).to_bytes();
        VerifierClient::new(&env, &cfg.verifier).verify(&seal, &cfg.image_id, &journal_digest);

        // 2. Parse the journal (fixed layout).
        if journal.len() != JOURNAL_LEN {
            panic_with(&env, Error::BadJournal);
        }
        let liabilities_root = read_bytes32(&env, &journal, 0);
        let domain = read_bytes32(&env, &journal, 32);
        let reserves = read_i128(&journal, 64);
        let nc = read_i128(&journal, 80);
        let ratio_bps = read_u32(&journal, 96);
        let j_epoch = read_u32(&journal, 100);
        let reserves_checked = journal.get(104).unwrap_or(0) != 0;
        let floor_checked = journal.get(105).unwrap_or(0) != 0;
        let solvent = journal.get(106).unwrap_or(0) != 0;

        // 3. Bind the proof's public inputs to live chain state.
        if domain != cfg.domain {
            panic_with(&env, Error::DomainMismatch);
        }
        let next_epoch = epoch(&env)
            .checked_add(1)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        if j_epoch != next_epoch {
            panic_with(&env, Error::EpochMismatch);
        }
        let live_reserves = token::TokenClient::new(&env, &cfg.reserve_token)
            .balance(&env.current_contract_address());
        if reserves != live_reserves {
            panic_with(&env, Error::ReservesMismatch);
        }
        if nc != net_custodied(&env) {
            panic_with(&env, Error::NetCustodiedMismatch);
        }
        if ratio_bps != cfg.min_ratio_bps {
            panic_with(&env, Error::RatioMismatch);
        }

        // 4. Require a SOLVENT verdict. (P7/F5 will instead record INSOLVENT and
        //    trigger wind-down; in P3 an insolvent proof is rejected.)
        if !(solvent && reserves_checked && floor_checked) {
            panic_with(&env, Error::Insolvent);
        }

        // 5. Record + bump epoch (anti-replay).
        let ledger = env.ledger().sequence();
        let attestation = Attestation {
            liabilities_root,
            reserves,
            net_custodied: nc,
            ratio_bps,
            epoch: j_epoch,
            ledger,
            reserves_checked,
            floor_checked,
            solvent,
        };
        env.storage()
            .instance()
            .set(&DataKey::LatestAttestation, &attestation);
        env.storage().instance().set(&DataKey::Epoch, &j_epoch);
        bump_instance(&env);

        Attested {
            epoch: j_epoch,
            ledger,
            solvent,
            ratio_bps,
        }
        .publish(&env);
    }

    // ----- Views -----

    /// Live on-chain reserves: the vault's own balance of the reserve token.
    pub fn reserves(env: Env) -> i128 {
        let cfg = get_config(&env);
        token::TokenClient::new(&env, &cfg.reserve_token).balance(&env.current_contract_address())
    }

    /// The most recent accepted attestation, if any.
    pub fn latest_attestation(env: Env) -> Option<Attestation> {
        env.storage().instance().get(&DataKey::LatestAttestation)
    }

    pub fn net_custodied(env: Env) -> i128 {
        net_custodied(&env)
    }

    /// Whether the latest attestation is within the freshness window (`false` if
    /// none). In `Enforced` mode, operator outflows are blocked while this is `false`.
    pub fn attestation_fresh(env: Env) -> bool {
        is_fresh(&env, &get_config(&env))
    }

    /// Maximum the operator could withdraw right now. `AttestationOnly`: the full
    /// live reserve balance. `Enforced`: `reserves - net_custodied` while a fresh
    /// proof is on record, else `0`. (Convenience for the operator dashboard.)
    pub fn max_operator_withdrawable(env: Env) -> i128 {
        let cfg = get_config(&env);
        let live = token::TokenClient::new(&env, &cfg.reserve_token)
            .balance(&env.current_contract_address());
        match cfg.mode {
            Mode::AttestationOnly => live,
            Mode::Enforced => {
                if !is_fresh(&env, &cfg) {
                    return 0;
                }
                let floor = net_custodied(&env);
                if live > floor {
                    live - floor
                } else {
                    0
                }
            }
        }
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

// --- fixed-layout journal readers (caller guarantees length == JOURNAL_LEN) ---

fn read_bytes32(env: &Env, b: &Bytes, off: u32) -> BytesN<32> {
    let mut a = [0u8; 32];
    for (k, slot) in a.iter_mut().enumerate() {
        *slot = b.get(off + k as u32).unwrap_or(0);
    }
    BytesN::from_array(env, &a)
}

fn read_i128(b: &Bytes, off: u32) -> i128 {
    // 16 big-endian bytes; values are non-negative (zero-extended) by construction.
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
