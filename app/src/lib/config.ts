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
export const AUDIT_IMAGE_ID =
  "847c5e63c69a9daae262635168812aadc468c2783a5db9aa410749e0c94d5a6b";

// Any existing account works as a read-only simulation source.
export const SIM_SOURCE =
  "GAKDJF75JLWEOGIUIHJLCZKL2IEHELKTVXOHD4L6AGHAQT4YZE4MWROT";

// Reserve asset is shown with 7 decimals (Stellar stroops).
export const RESERVE_DECIMALS = 7;

export function contractUrl(id: string): string {
  return `${EXPLORER}/contract/${id}`;
}
export function txUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}
