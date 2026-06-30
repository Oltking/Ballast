// Read-only access to the generic ZK credential registry (P-A). The registry
// verifies + records ANY RISC Zero predicate proof against the same Groth16
// verifier the vault uses; the Credit Passport is predicate #1.
//
// Every call here is a read: we simulate a view against the deployed registry
// and decode the result — no wallet, no signature, just the ledger's truth.

import { StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { readView } from "./stellar.ts";
import { REGISTRY_ID } from "./config.ts";
import { bytesToHex } from "./format.ts";

// Credit Passport predicate id (live on testnet).
export const PASSPORT_PREDICATE_ID = 1;

// ---- arg encoders ----

function u32(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u32" });
}

/** A 32-byte subject id, given as hex (64 chars) or raw bytes, as a ScVal. */
function subjectArg(subjectHex: string): xdr.ScVal {
  const hex = subjectHex.replace(/^0x/, "");
  if (hex.length !== 64) throw new Error("subject must be 32 bytes (64 hex chars)");
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
}

/** Turn a Stellar account address (G…) into its 32-byte subject id (hex). */
export function addressToSubjectHex(address: string): string {
  const raw = StrKey.decodeEd25519PublicKey(address.trim()); // 32-byte Buffer
  return bytesToHex(raw);
}

// ---- decoded view shapes ----

export type PredicateInfo = {
  image_id: Uint8Array;
  fresh_window: number;
  label: string;
  anchor: Uint8Array;
  active: boolean;
};

export type CredentialInfo = {
  subject: Uint8Array;
  predicate_id: number;
  param: bigint; // the proven threshold
  nonce: number;
  ledger: number; // ledger the credential was recorded at
};

export type RegistryConfig = {
  admin: string;
  verifier: string;
  domain: Uint8Array;
};

// scValToNative decodes contract structs to plain objects keyed by field name.
// The shapes below normalize the few fields we render as numbers / bigints.

/** Predicate metadata (image id pinned, freshness window, label, anchor root). */
export async function getPredicate(
  predicateId: number = PASSPORT_PREDICATE_ID,
): Promise<PredicateInfo | null> {
  const raw = (await readView("predicate", [u32(predicateId)], REGISTRY_ID)) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!raw) return null;
  return {
    image_id: raw.image_id as Uint8Array,
    fresh_window: Number(raw.fresh_window ?? 0),
    label: String(raw.label ?? ""),
    anchor: raw.anchor as Uint8Array,
    active: Boolean(raw.active),
  };
}

/** The recorded credential for a subject under a predicate, if any. */
export async function getCredential(
  subjectHex: string,
  predicateId: number = PASSPORT_PREDICATE_ID,
): Promise<CredentialInfo | null> {
  const raw = (await readView(
    "credential",
    [subjectArg(subjectHex), u32(predicateId)],
    REGISTRY_ID,
  )) as Record<string, unknown> | null | undefined;
  if (!raw) return null;
  return {
    subject: raw.subject as Uint8Array,
    predicate_id: Number(raw.predicate_id ?? predicateId),
    param: BigInt((raw.param as bigint | number | string) ?? 0),
    nonce: Number(raw.nonce ?? 0),
    ledger: Number(raw.ledger ?? 0),
  };
}

/** Does a fresh, valid credential exist? maxAge=0 means "freshness not checked
 *  here" (the predicate's own fresh_window still applies on issuance). */
export async function isValid(
  subjectHex: string,
  predicateId: number = PASSPORT_PREDICATE_ID,
  maxAge = 0,
): Promise<boolean> {
  const ok = await readView(
    "is_valid",
    [subjectArg(subjectHex), u32(predicateId), u32(maxAge)],
    REGISTRY_ID,
  );
  return Boolean(ok);
}

/** Registry config: admin, the verifier it routes proofs through, its domain. */
export async function getRegistryConfig(): Promise<RegistryConfig | null> {
  const raw = (await readView("config", [], REGISTRY_ID)) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!raw) return null;
  return {
    admin: String(raw.admin ?? ""),
    verifier: String(raw.verifier ?? ""),
    domain: raw.domain as Uint8Array,
  };
}
