// Network + deployed-contract constants. Testnet only (research prototype).
// Mirrors the project .env; kept here because the frontend is read-mostly and
// these ids are public on-chain anyway.

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const EXPLORER = "https://stellar.expert/explorer/testnet";

// Deployed testnet contracts (see README "Deployed (testnet)").
export const VAULT_ID =
  "CCEAU43KHDUHF4CTLTJGTD4Y5ZHYW3CYFPWSHCZXP3WNLZILK4Q4DP65";
export const VERIFIER_ROUTER =
  "CDLRCNMFXMNZIS3F4HCEGORXC4UM5XRAD7ZWBSWMDUAAZLRMVPQB2U4R";
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
  "de044c9b0cca5ebefaa13ac9a9b6290131db3c123db344cbee4a6480e2c7dd27";

// Any existing account works as a read-only simulation source.
export const SIM_SOURCE =
  "GAKDJF75JLWEOGIUIHJLCZKL2IEHELKTVXOHD4L6AGHAQT4YZE4MWROT";

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
