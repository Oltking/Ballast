// Backend logic tests: the store, the sum-tree/credit-tree roots (which MUST
// match the Rust guest), and the wallet-challenge auth. No Redis, no chain.

import { describe, it, expect } from "vitest";
import { Keypair, StrKey, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { getStore } from "./store.ts";
import { buildSumTree, hex as sumHex, type Leaf } from "../../src/lib/sumtree.ts";
import { buildCreditRoot } from "./credit.ts";
import { issueChallenge, requireWalletAuth, subjectOf } from "./http.ts";
import { NETWORK_PASSPHRASE } from "./chain.ts";

function hexToBytes(h: string) {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
}

describe("store (in-memory)", () => {
  it("acquireOnce debounces within the window", async () => {
    const s = getStore();
    expect(await s.acquireOnce("k-test-1", 60)).toBe(true);
    expect(await s.acquireOnce("k-test-1", 60)).toBe(false);
  });

  it("ensures and updates a user", async () => {
    const s = getStore();
    const subject = "aa".repeat(32);
    const u = await s.ensureUser(subject, "G_addr", 1);
    expect(u.balance).toBe("0");
    expect(u.salt).toHaveLength(64);
    await s.setBalance(subject, "5000");
    expect((await s.getUser(subject))!.balance).toBe("5000");
  });
});

describe("liabilities sum-tree root (== Rust ballast-core)", () => {
  it("matches the known parity root for a fixed two-leaf book", async () => {
    const leaf = (acc: string, bal: string, salt: string): Leaf => ({
      account: Array.from(hexToBytes(acc)),
      balance: bal,
      salt: Array.from(hexToBytes(salt)),
    });
    const { root, total } = await buildSumTree([
      leaf("11".repeat(32), "700000000", "aa" + "00".repeat(31)),
      leaf("22".repeat(32), "300000000", "bb" + "00".repeat(31)),
    ]);
    expect(total.toString()).toBe("1000000000");
    expect(sumHex(root)).toBe(
      "4f47943c4b140112fb1f615f3d0b06a64996dc7dac439a2a244394a789d200fa",
    );
  });
});

describe("credit-passport root (== Rust passport guest)", () => {
  it("matches the deployed anchor for the demo book", async () => {
    const mk = (tag: number, repaid: number, defaults: number) => ({
      subject: tag.toString(16).padStart(2, "0").repeat(32),
      address: "",
      repaid,
      defaults,
      salt: ((tag + 0x40) & 0xff).toString(16).padStart(2, "0").repeat(32),
    });
    const book = [mk(0x11, 12, 0), mk(0x22, 3, 2), mk(0x33, 30, 0), mk(0x44, 0, 0)];
    const root = await buildCreditRoot(book);
    const hex = Array.from(root).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("db70e738ae7f165deb8cace79ca02e19f0a4ada2cbd5a732846ec8bcfff3d211");
  });
});

describe("wallet challenge auth", () => {
  it("accepts a correctly signed challenge and derives the subject", async () => {
    const kp = Keypair.random();
    const addr = kp.publicKey();
    const { xdr } = await issueChallenge(addr);
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
    tx.sign(kp);
    const authed = await requireWalletAuth({ address: addr, signedXdr: tx.toXDR() });
    expect(authed).toBe(addr);
    expect(subjectOf(addr)).toBe(
      Buffer.from(StrKey.decodeEd25519PublicKey(addr)).toString("hex"),
    );
  });

  it("rejects a challenge signed by a different key", async () => {
    const kp = Keypair.random();
    const attacker = Keypair.random();
    const { xdr } = await issueChallenge(kp.publicKey());
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
    tx.sign(attacker); // wrong signer
    await expect(
      requireWalletAuth({ address: kp.publicKey(), signedXdr: tx.toXDR() }),
    ).rejects.toThrow();
  });

  it("rejects a replayed challenge (one-time use)", async () => {
    const kp = Keypair.random();
    const { xdr } = await issueChallenge(kp.publicKey());
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
    tx.sign(kp);
    const signed = tx.toXDR();
    await requireWalletAuth({ address: kp.publicKey(), signedXdr: signed });
    await expect(
      requireWalletAuth({ address: kp.publicKey(), signedXdr: signed }),
    ).rejects.toThrow();
  });
});

// silence unused import lint for hexToBytes if tree-shaken
void hexToBytes;
