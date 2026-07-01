#![no_std]
//! # Ballast Pool
//!
//! A **private, provably-solvent lending pool** for Stellar. It is a close
//! variant of the Ballast solvency [vault](../../vault), with ONE crucial
//! change: the pool's **assets are `cash + outstanding loans`**, not just cash.
//!
//! Lenders deposit a single stablecoin (held as a Stellar Asset Contract token).
//! Their per-lender positions live in a *private* off-chain sum-tree book,
//! exactly like the vault's liabilities book. The operator originates loans:
//! disbursing converts `cash` into a `receivable` (`outstanding`), so
//! `assets = cash + outstanding` is **unchanged by a disbursement** —
//! solvency (`assets >= Σ lender_claims`) is preserved *by construction*.
//!
//! The pool proves in zero-knowledge that `cash + outstanding >= Σ lender_claims`
//! using the **same guest and the same 107-byte journal** the vault uses. The
//! only difference is the on-chain binding: where the vault binds the journal's
//! `reserves` to `token.balance(self)`, the pool binds it to
//! **`assets() = cash() + outstanding`**. `net_custodied` binds to `pooled`
//! (Σ lender net deposits = the lender-claims floor).
//!
//! So the guest predicate `reserves >= ratio · L` and `L >= net_custodied`
//! becomes `assets >= ratio · L >= ratio · pooled` = pool solvency over the
//! private lender book, with `L` (total claims) never revealed.

use soroban_sdk::{
    contract, contractclient, contractevent, contracterror, contractimpl, contracttype,
    panic_with_error, token, Address, Bytes, BytesN, Env,
};

// ----------------------------------------------------------------------------
// Errors (numeric codes are stable within this contract)
// ----------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    InvalidAmount = 3,
    /// Arithmetic overflow on an accounting update.
    Overflow = 4,
    /// `max_staleness_ledgers` or `min_ratio_bps` out of range at init.
    InvalidConfig = 5,
    /// Journal byte length doesn't match the expected layout.
    BadJournal = 6,
    /// Journal `domain` != this pool (cross-contract proof reuse).
    DomainMismatch = 7,
    /// Journal `epoch` != stored epoch + 1 (stale/replayed proof).
    EpochMismatch = 8,
    /// Journal `reserves` != the pool's live `assets()` (cash + outstanding).
    ReservesMismatch = 9,
    /// Journal `net_custodied` != the pool's on-chain `pooled` floor.
    NetCustodiedMismatch = 10,
    /// Journal `ratio_bps` != the pool's configured minimum ratio.
    RatioMismatch = 11,
    /// Borrow attempted in Enforced mode with no attestation on record.
    NoAttestation = 12,
    /// Borrow blocked: latest attestation older than `max_staleness_ledgers`.
    StaleAttestation = 13,
    /// Not enough live cash on hand (funds are lent out); lenders can only
    /// redeem available liquidity, and borrows can't exceed cash.
    InsufficientLiquidity = 14,
    /// Lender withdrawal would push the `pooled` claims floor below zero.
    InsufficientPooled = 15,
    /// The latest attestation is INSOLVENT (or the pool is in wind-down): the
    /// operator may not originate new loans. Also raised by a failed proof.
    Insolvent = 16,
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/// Enforcement tier. `AttestationOnly` records proofs but does not gate
/// borrows; `Enforced` gates loan origination on a fresh, solvent proof.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Mode {
    AttestationOnly = 0,
    Enforced = 1,
}

/// Operational status (circuit-breaker). `WindDown` blocks new loan origination;
/// lenders can always redeem available cash regardless of status.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Status {
    Healthy = 0,
    WindDown = 1,
}

/// Public, third-party-readable solvency credential. `L` stays private —
/// `margin` here is the public lower bound `assets - pooled` (the surplus).
#[contracttype]
#[derive(Clone)]
pub struct SolvencyCredential {
    pub solvent: bool,
    pub ratio_bps: u32,
    pub epoch: u32,
    pub ledger: u32,
    pub margin: i128,
    pub fresh: bool,
    pub status: Status,
}

/// Immutable-ish configuration set at initialization. Same shape as the vault's.
#[contracttype]
#[derive(Clone)]
pub struct Config {
    pub admin: Address,
    pub operator: Address,
    /// SAC contract id of the single reserve stablecoin.
    pub reserve_token: Address,
    /// `stellar-risc0-verifier` router contract id.
    pub verifier: Address,
    /// Pinned RISC Zero audit-guest image id.
    pub image_id: BytesN<32>,
    pub mode: Mode,
    /// Freshness window for the enforced tier.
    pub max_staleness_ledgers: u32,
    /// Minimum over-collateralization ratio in basis points; 10_000 = 100%.
    pub min_ratio_bps: u32,
    /// Domain-separation tag bound into every proof journal (this pool's id).
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
///
/// For the pool, `reserves` is bound to `assets()` and `net_custodied` to `pooled`.
#[contracttype]
#[derive(Clone)]
pub struct Attestation {
    pub liabilities_root: BytesN<32>,
    /// Bound to the pool's `assets()` (cash + outstanding) at attestation time.
    pub reserves: i128,
    /// Bound to the pool's `pooled` (lender-claims floor).
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
// Events. Flow amount + the running total after the flow.
// ----------------------------------------------------------------------------

#[contractevent]
#[derive(Clone)]
pub struct LenderDeposit {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub pooled: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct LenderWithdraw {
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub pooled: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct Borrow {
    #[topic]
    pub borrower: Address,
    pub amount: i128,
    pub outstanding: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct Repay {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub outstanding: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct WriteOff {
    pub amount: i128,
    pub outstanding: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct Attested {
    pub epoch: u32,
    pub ledger: u32,
    pub solvent: bool,
    pub ratio_bps: u32,
}

/// Emitted whenever operational status changes.
#[contractevent]
#[derive(Clone)]
pub struct StatusChanged {
    pub healthy: bool,
    pub epoch: u32,
    pub ledger: u32,
}

#[contracttype]
pub enum DataKey {
    /// `Config`
    Config,
    /// `i128` — Σ lender net deposits = the lender-claims floor (analogous to the
    /// vault's `net_custodied`). Only lender deposits/withdrawals move it.
    Pooled,
    /// `i128` — total loan principal currently lent out.
    Outstanding,
    /// `u32` — increments per accepted attestation (anti-replay).
    Epoch,
    /// `Attestation` — the most recent accepted attestation.
    LatestAttestation,
    /// `Status` — operational status.
    Status,
}

// ----------------------------------------------------------------------------
// Storage helpers
// ----------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280; // ~5s ledgers/day
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

fn get_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with(env, Error::NotInitialized))
}

fn pooled(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Pooled).unwrap_or(0)
}

fn set_pooled(env: &Env, v: i128) {
    env.storage().instance().set(&DataKey::Pooled, &v);
}

fn outstanding(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::Outstanding)
        .unwrap_or(0)
}

fn set_outstanding(env: &Env, v: i128) {
    env.storage().instance().set(&DataKey::Outstanding, &v);
}

fn epoch(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Epoch).unwrap_or(0)
}

/// Live cash: the pool's own on-chain balance of the reserve token.
fn cash(env: &Env, cfg: &Config) -> i128 {
    token::TokenClient::new(env, &cfg.reserve_token).balance(&env.current_contract_address())
}

/// Total assets = cash + outstanding loans. This is what the proof binds to.
fn assets(env: &Env, cfg: &Config) -> i128 {
    cash(env, cfg)
        .checked_add(outstanding(env))
        .unwrap_or_else(|| panic_with(env, Error::Overflow))
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

fn status(env: &Env) -> Status {
    env.storage()
        .instance()
        .get(&DataKey::Status)
        .unwrap_or(Status::Healthy)
}

fn set_status(env: &Env, s: Status) {
    env.storage().instance().set(&DataKey::Status, &s);
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
pub struct PoolContract;

#[contractimpl]
impl PoolContract {
    /// Initialize the pool. Idempotent-guarded. `min_ratio_bps` must be
    /// >= 10_000 (at least 1:1 backing); `max_staleness_ledgers` must be > 0.
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
        env.storage().instance().set(&DataKey::Pooled, &0i128);
        env.storage().instance().set(&DataKey::Outstanding, &0i128);
        env.storage().instance().set(&DataKey::Epoch, &0u32);
        bump_instance(&env);
    }

    /// Lender deposit. Pulls `amount` of the reserve token from `from` into the
    /// pool and credits the `pooled` claims floor. Raises both cash and pooled.
    pub fn lender_deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        require_positive(&env, amount);
        let cfg = get_config(&env);

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let p = pooled(&env)
            .checked_add(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        set_pooled(&env, p);
        bump_instance(&env);

        LenderDeposit {
            from,
            amount,
            pooled: p,
        }
        .publish(&env);
    }

    /// Lender redemption. The operator orchestrates redemptions from the private
    /// lender book. Because funds may be lent out, a lender can only withdraw
    /// against **available cash** — this reverts with `InsufficientLiquidity` if
    /// live cash `< amount`. **Never gated by solvency/staleness**: lenders can
    /// always redeem available liquidity. Reduces both cash and `pooled`.
    pub fn lender_withdraw(env: Env, to: Address, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        if cash(&env, &cfg) < amount {
            panic_with(&env, Error::InsufficientLiquidity);
        }
        let p = pooled(&env)
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));
        if p < 0 {
            panic_with(&env, Error::InsufficientPooled);
        }

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &env.current_contract_address(),
            &to,
            &amount,
        );
        set_pooled(&env, p);
        bump_instance(&env);

        LenderWithdraw {
            to,
            amount,
            pooled: p,
        }
        .publish(&env);
    }

    /// Originate a loan: disburse `amount` cash to `borrower` and record it as a
    /// receivable (`outstanding += amount`). The operator originates after an
    /// off-chain passport/credit check.
    ///
    /// This preserves `assets = cash + outstanding` (cash down, outstanding up by
    /// the same amount), so pool solvency is unchanged by the disbursement.
    ///
    /// Gated in `Enforced` mode: a **fresh, solvent** attestation must be on
    /// record (`NoAttestation` / `StaleAttestation` / `Insolvent`). Requires live
    /// cash `>= amount` (`InsufficientLiquidity`).
    pub fn borrow(env: Env, borrower: Address, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        if cash(&env, &cfg) < amount {
            panic_with(&env, Error::InsufficientLiquidity);
        }

        // Enforcement gate (operator-only; lenders are never gated).
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
            if !att.solvent || status(&env) == Status::WindDown {
                panic_with(&env, Error::Insolvent);
            }
        }

        let o = outstanding(&env)
            .checked_add(amount)
            .unwrap_or_else(|| panic_with(&env, Error::Overflow));

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &env.current_contract_address(),
            &borrower,
            &amount,
        );
        set_outstanding(&env, o);
        bump_instance(&env);

        Borrow {
            borrower,
            amount,
            outstanding: o,
        }
        .publish(&env);
    }

    /// Repay loan principal. Pulls `amount` in from `from` and reduces
    /// `outstanding` (clamped at zero). Any excess over `outstanding` is interest
    /// that simply stays as cash → pool surplus / lender yield.
    pub fn repay(env: Env, from: Address, amount: i128) {
        from.require_auth();
        require_positive(&env, amount);
        let cfg = get_config(&env);

        token::TokenClient::new(&env, &cfg.reserve_token).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        let cur = outstanding(&env);
        let o = if amount >= cur { 0 } else { cur - amount };
        set_outstanding(&env, o);
        bump_instance(&env);

        Repay {
            from,
            amount,
            outstanding: o,
        }
        .publish(&env);
    }

    /// Write off defaulted principal: `outstanding = max(outstanding - amount, 0)`
    /// with **no cash change**. Models a default — it drops `assets` below the
    /// `pooled` claims floor, so the next attestation proves INSOLVENT and trips
    /// the pool into wind-down.
    pub fn write_off(env: Env, amount: i128) {
        let cfg = get_config(&env);
        cfg.operator.require_auth();
        require_positive(&env, amount);

        let cur = outstanding(&env);
        let o = if amount >= cur { 0 } else { cur - amount };
        set_outstanding(&env, o);
        bump_instance(&env);

        WriteOff {
            amount,
            outstanding: o,
        }
        .publish(&env);
    }

    // ----- Admin setters (mirror the vault) -----

    /// Switch enforcement tier.
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

    /// Re-pin the trusted RISC Zero guest image id.
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
    /// every public value to live chain state → record + bump epoch.
    ///
    /// **The pool's one real difference from the vault** is the binding:
    /// - `journal.reserves == assets()` (cash + outstanding), and
    /// - `journal.net_custodied == pooled`.
    ///
    /// So the same guest (`reserves >= ratio · L`, `L >= net_custodied`) proves
    /// `assets >= ratio · pooled` = pool solvency over the private lender book.
    /// `L` (total lender claims) is never in the journal and never learned here.
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
        // *** THE KEY CHANGE vs. the vault: bind reserves to assets(), not cash. ***
        if reserves != assets(&env, &cfg) {
            panic_with(&env, Error::ReservesMismatch);
        }
        if nc != pooled(&env) {
            panic_with(&env, Error::NetCustodiedMismatch);
        }
        if ratio_bps != cfg.min_ratio_bps {
            panic_with(&env, Error::RatioMismatch);
        }

        // 4. Record the (cryptographically valid, chain-bound) attestation —
        //    whatever its verdict. An honest INSOLVENT proof becomes a
        //    transparent, handled state (wind-down) rather than a rejection.
        let verdict_solvent = solvent && reserves_checked && floor_checked;
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
            solvent: verdict_solvent,
        };
        env.storage()
            .instance()
            .set(&DataKey::LatestAttestation, &attestation);
        env.storage().instance().set(&DataKey::Epoch, &j_epoch);

        // 5. A solvent proof keeps/returns the pool to Healthy; an insolvent one
        //    trips the breaker into WindDown.
        let prev = status(&env);
        let next = if verdict_solvent {
            Status::Healthy
        } else {
            Status::WindDown
        };
        if next != prev {
            set_status(&env, next);
            StatusChanged {
                healthy: verdict_solvent,
                epoch: j_epoch,
                ledger,
            }
            .publish(&env);
        }
        bump_instance(&env);

        Attested {
            epoch: j_epoch,
            ledger,
            solvent: verdict_solvent,
            ratio_bps,
        }
        .publish(&env);
    }

    // ----- Views -----

    /// Live cash: the pool's own balance of the reserve token.
    pub fn cash(env: Env) -> i128 {
        let cfg = get_config(&env);
        cash(&env, &cfg)
    }

    /// Total loan principal currently lent out.
    pub fn outstanding(env: Env) -> i128 {
        outstanding(&env)
    }

    /// Σ lender net deposits = the lender-claims floor.
    pub fn pooled(env: Env) -> i128 {
        pooled(&env)
    }

    /// Total assets backing lender claims = `cash() + outstanding`. This is the
    /// quantity the proof binds `reserves` to.
    pub fn assets(env: Env) -> i128 {
        let cfg = get_config(&env);
        assets(&env, &cfg)
    }

    /// Yield buffer = `assets() - pooled` (may be negative if under-collateralized
    /// after a write-off).
    pub fn surplus(env: Env) -> i128 {
        let cfg = get_config(&env);
        assets(&env, &cfg) - pooled(&env)
    }

    /// The most recent accepted attestation, if any.
    pub fn latest_attestation(env: Env) -> Option<Attestation> {
        env.storage().instance().get(&DataKey::LatestAttestation)
    }

    pub fn epoch(env: Env) -> u32 {
        epoch(&env)
    }

    /// Whether the latest attestation is within the freshness window (`false` if
    /// none). In `Enforced` mode, borrows are blocked while this is `false`.
    pub fn attestation_fresh(env: Env) -> bool {
        is_fresh(&env, &get_config(&env))
    }

    pub fn config(env: Env) -> Config {
        get_config(&env)
    }

    /// Operational status: `Healthy` or `WindDown`.
    pub fn status(env: Env) -> Status {
        status(&env)
    }

    /// Public solvency credential any third party can read. `margin` is the
    /// public lower bound on surplus (`assets - pooled`); `L` stays private.
    pub fn solvency_credential(env: Env) -> Option<SolvencyCredential> {
        let cfg = get_config(&env);
        let att: Attestation = env.storage().instance().get(&DataKey::LatestAttestation)?;
        Some(SolvencyCredential {
            solvent: att.solvent,
            ratio_bps: att.ratio_bps,
            epoch: att.epoch,
            ledger: att.ledger,
            margin: assets(&env, &cfg) - pooled(&env),
            fresh: is_fresh(&env, &cfg),
            status: status(&env),
        })
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
