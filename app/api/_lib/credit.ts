// The credit-passport issuer's record set → the PLAIN Merkle root the registry
// anchors and the guest proves against. Byte-faithful port of
// `guest/core/src/passport.rs`:
//   leaf = SHA-256( subject[32] || repaid_be(u32)[4] || defaults_be(u32)[4] || salt[32] )
//   node = SHA-256( left[32] || right[32] )           (no sums — plain tree)
//   pad with empty (zero) leaves to a power of two; empty set → zero root.
// Records are ordered by subject ascending (canonical) so the issuer, the prover
// and the registry anchor all agree on the root.

import { getStore, type BorrowerRecord, type Store } from "./store.js";

const EMPTY = new Uint8Array(32);

function hexToBytes(h: string): Uint8Array {
  const c = h.replace(/^0x/, "");
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function u32be(n: number): Uint8Array {
  const o = new Uint8Array(4);
  o[0] = (n >>> 24) & 0xff;
  o[1] = (n >>> 16) & 0xff;
  o[2] = (n >>> 8) & 0xff;
  o[3] = n & 0xff;
  return o;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const data = concat(parts);
  const buf = new ArrayBuffer(data.length);
  new Uint8Array(buf).set(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export async function hashCreditLeaf(r: BorrowerRecord): Promise<Uint8Array> {
  return sha256([hexToBytes(r.subject), u32be(r.repaid), u32be(r.defaults), hexToBytes(r.salt)]);
}

async function hashPair(l: Uint8Array, r: Uint8Array): Promise<Uint8Array> {
  return sha256([l, r]);
}

/** Load borrower records in canonical (sorted-by-subject) order. */
export async function loadBorrowerRecords(store: Store = getStore()): Promise<BorrowerRecord[]> {
  const subjects = (await store.allBorrowerSubjects()).slice().sort();
  const out: BorrowerRecord[] = [];
  for (const s of subjects) {
    const b = await store.getBorrower(s);
    if (b) out.push(b);
  }
  return out;
}

export async function buildCreditRoot(records: BorrowerRecord[]): Promise<Uint8Array> {
  if (records.length === 0) return EMPTY;
  let level: Uint8Array[] = [];
  for (const r of records) level.push(await hashCreditLeaf(r));
  let n = 1;
  while (n < level.length) n <<= 1;
  while (level.length < n) level.push(EMPTY);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hashPair(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

export type PlainStep = { sibling: string; is_left: boolean };

/** Inclusion path for the record at `index` (mirrors prove_credit_inclusion). */
export async function proveCreditInclusion(
  records: BorrowerRecord[],
  index: number,
): Promise<PlainStep[]> {
  let level: Uint8Array[] = [];
  for (const r of records) level.push(await hashCreditLeaf(r));
  let n = 1;
  while (n < level.length) n <<= 1;
  while (level.length < n) level.push(EMPTY);
  const path: PlainStep[] = [];
  let idx = index;
  while (level.length > 1) {
    const isLeft = idx % 2 === 0;
    const sib = idx ^ 1;
    path.push({ sibling: hex(level[sib]), is_left: isLeft });
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hashPair(level[i], level[i + 1]));
    level = next;
    idx >>= 1;
  }
  return path;
}

export async function creditRootHex(store: Store = getStore()): Promise<{ root: string; count: number }> {
  const records = await loadBorrowerRecords(store);
  return { root: hex(await buildCreditRoot(records)), count: records.length };
}
