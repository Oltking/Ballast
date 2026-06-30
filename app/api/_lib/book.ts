// The operator's private liabilities book → the Merkle SUM-tree the solvency
// proof commits to. Reuses the SAME hashing as the client check and the Rust
// guest (`sumtree.ts` is a byte-faithful port of `ballast-core`), so the root
// the backend publishes is identical to the one the prover proves and the vault
// records. Leaf order is fixed (subjects sorted ascending) so every party agrees.

import { buildSumTree, proveInclusion, hexToBytes, hex, type Leaf } from "../../src/lib/sumtree.ts";
import { getStore, type Store } from "./store.ts";

export type BookLeaf = { account: string; balance: string; salt: string }; // hex/stroops

function toLeaf(l: BookLeaf): Leaf {
  return {
    account: Array.from(hexToBytes(l.account)),
    balance: l.balance,
    salt: Array.from(hexToBytes(l.salt)),
  };
}

/** Load every user's leaf in the canonical (sorted-by-subject) order. */
export async function loadBookLeaves(store: Store = getStore()): Promise<BookLeaf[]> {
  const subjects = (await store.allUserSubjects()).slice().sort();
  const out: BookLeaf[] = [];
  for (const s of subjects) {
    const u = await store.getUser(s);
    if (!u) continue;
    out.push({ account: u.subject, balance: u.balance, salt: u.salt });
  }
  return out;
}

export type BookSummary = {
  root: string; // hex of the liabilities root
  total: string; // Σ balances (stroops) = L — PUBLIC here only as the aggregate
  count: number;
};

export async function bookSummary(store: Store = getStore()): Promise<BookSummary> {
  const leaves = await loadBookLeaves(store);
  const { root, total } = await buildSumTree(leaves.map(toLeaf));
  return { root: hex(root), total: total.toString(), count: leaves.length };
}

/** An inclusion proof for one subject against the current book root, or null if
 *  the subject isn't in the book. Reveals only THIS subject's leaf + path. */
export async function inclusionForSubject(subject: string, store: Store = getStore()) {
  const leaves = await loadBookLeaves(store);
  const index = leaves.findIndex((l) => l.account.toLowerCase() === subject.toLowerCase());
  if (index < 0) return null;
  const proof = await proveInclusion(leaves.map(toLeaf), index);
  const { root } = await buildSumTree(leaves.map(toLeaf));
  return { proof, root: hex(root), index };
}
