// Network + deployed-contract constants. Testnet only (research prototype).
// Mirrors the project .env; kept here because the frontend is read-mostly and
// these ids are public on-chain anyway.

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const EXPLORER = "https://stellar.expert/explorer/testnet";

// Deployed testnet contracts (see README "Deployed (testnet)").
export const VAULT_ID =
  "CAULRHZ5WKYXHQJTF3BC3AV4QHOIEPDN5LIGDBWS6UOJ76YLLPT3VONR";
export const VERIFIER_ROUTER =
  "CCZ6SXH2FQ2CW3AIIUPHIKHXRJK5X55MTQS6P46MAPK7I6S4XIU6DOYF";
// Generic ZK credential registry (P-A): verifies + records ANY RISC Zero
// predicate proof against the same verifier above. The vault is one consumer;
// new predicates register here with no contract redeploy.
export const REGISTRY_ID =
  "CDJ7GMWC2253BCPQVH2N37RKVXTLBKH7QGIAKF54DQEYJI4Q6X7M4I2D";
export const REGISTRY_DOMAIN =
  "d3f332c2d6bbb089f0a9f4ddfe2aade6b0a8ff81900517bc1c0984a390f5fece";
// On-chain loan ledger — the credit-history source the passport issuer derives
// borrower (repaid, defaults) records from.
export const LOANBOOK_ID =
  "CBIUJ4CFSUIZNZWRUPDD5E3TL2G5VYQO6KF26J6DKS2MBU3LBIS4KRTB";
// ZK lending pool — a provably-solvent vault whose assets = cash + outstanding
// loans, so the SAME solvency proof guarantees lenders are covered. Lenders'
// positions are private; borrowing is gated by the ZK Credit Passport.
export const POOL_ID =
  "CBHRVLIQVELF35DSPR2EY6MIJ72WW35IDHN52HXEHSMKRBG25R7FAPVA";
export const POOL_DOMAIN =
  "4f1aad10a9165df4727c744c79884ff56b6fa819dbdd1ee43c98a884daec7e50";
export const USDC_SAC =
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
// The classic asset the SAC wraps (Circle testnet USDC, home_domain centre.io).
// Customers need a trustline to this asset + a balance before they can deposit.
export const USDC_CODE = "USDC";
export const USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// External faucets (Circle issues this exact testnet USDC; friendbot funds XLM).
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
// Guest program id the vault is pinned to (chain is source of truth — read from
// the deployed vault's config.image_id). Re-pinned to the local Mac build.
export const AUDIT_IMAGE_ID =
  "4711b310d51b710b9150d21b7dced6b9e8c566d45ce9b8e33047d87287b77bdf";

// Any existing account works as a read-only simulation source.
export const SIM_SOURCE =
  "GCPBZLNW2F2X3KQEILWRJRFBNSHFKWNY6GFSBCB4I624D2KVRY6P2JLQ";

// Reserve asset is shown with 7 decimals (Stellar stroops).
export const RESERVE_DECIMALS = 7;

// Friendly, consumer-facing identity for the custodian this vault represents.
export const ISSUER_NAME = "Harbor USD";
export const ISSUER_KIND = "USD stablecoin reserve · Stellar";
export const ISSUER_INITIAL = "H";

export function contractUrl(id: string): string {
  return `${EXPLORER}/contract/${id}`;
}
export function txUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}
