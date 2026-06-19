// Client-side Merkle SUM-tree inclusion check — a faithful TS port of
// `ballast-core` (guest/core/src/lib.rs). MUST stay byte-identical to the Rust:
//   hash_leaf = SHA-256( account[32] || balance_be[8] || salt[32] )
//   hash_node = SHA-256( left[32] || right[32] || sum_be[16] )
// The holder's leaf NEVER leaves the device; only this local check runs.

export type Leaf = {
  account: number[]; // 32 bytes
  balance: number | string; // u64 (string to be safe for large values)
  salt: number[]; // 32 bytes
};

export type PathStep = {
  sibling_hash: number[]; // 32 bytes
  sibling_sum: number | string; // u128
  is_left: boolean;
};

export type InclusionProof = {
  leaf: Leaf;
  path: PathStep[];
};

function u64be(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u128be(v: bigint): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
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
  // Copy into a fresh ArrayBuffer so the arg is an unambiguous BufferSource.
  const buf = new ArrayBuffer(data.length);
  new Uint8Array(buf).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

function bytes32(arr: number[]): Uint8Array {
  if (arr.length !== 32) throw new Error("expected 32 bytes");
  return Uint8Array.from(arr);
}

export async function hashLeaf(leaf: Leaf): Promise<Uint8Array> {
  return sha256([
    bytes32(leaf.account),
    u64be(BigInt(leaf.balance)),
    bytes32(leaf.salt),
  ]);
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(h: string): Uint8Array {
  const clean = h.trim().replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const EMPTY_HASH = new Uint8Array(32);

/** Build the Merkle sum-tree root + total L over a book (mirrors build_sum_tree). */
export async function buildSumTree(
  leaves: Leaf[],
): Promise<{ root: Uint8Array; total: bigint }> {
  if (leaves.length === 0) return { root: EMPTY_HASH, total: 0n };
  let level: { hash: Uint8Array; sum: bigint }[] = [];
  for (const l of leaves) {
    level.push({ hash: await hashLeaf(l), sum: BigInt(l.balance) });
  }
  let n = 1;
  while (n < level.length) n <<= 1;
  while (level.length < n) level.push({ hash: EMPTY_HASH, sum: 0n });
  while (level.length > 1) {
    const next: { hash: Uint8Array; sum: bigint }[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const sum = level[i].sum + level[i + 1].sum;
      next.push({
        hash: await sha256([level[i].hash, level[i + 1].hash, u128be(sum)]),
        sum,
      });
    }
    level = next;
  }
  return { root: level[0].hash, total: level[0].sum };
}

/** Fold the authentication path to a root and compare against `root`. */
export async function verifyInclusion(
  proof: InclusionProof,
  root: Uint8Array,
): Promise<boolean> {
  let h = await hashLeaf(proof.leaf);
  let sum = BigInt(proof.leaf.balance);
  for (const step of proof.path) {
    const sib = bytes32(step.sibling_hash);
    const sibSum = BigInt(step.sibling_sum);
    const [lh, rh] = step.is_left ? [h, sib] : [sib, h];
    sum = step.is_left ? sum + sibSum : sibSum + sum;
    h = await sha256([lh, rh, u128be(sum)]);
  }
  return eqBytes(h, root);
}
