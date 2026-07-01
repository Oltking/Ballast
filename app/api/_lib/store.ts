// Persistence for the custodian backend (the operator's PRIVATE book + the
// credit-passport issuer's record set). Everything sensitive — per-user
// balances, the salts that hide each leaf, borrower records — lives here, server
// side, never on the client.
//
// Backed by Upstash Redis in production (one-click from the Vercel dashboard;
// set KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL/TOKEN).
// Falls back to a per-process in-memory map for local dev (NOT persistent across
// serverless invocations — provision Redis for any real deployment).

import { Redis } from "@upstash/redis";

export type UserRecord = {
  subject: string; // 64-hex (the account's ed25519 public key bytes)
  address: string; // G... strkey
  balance: string; // stroops, authoritative operator-credited liability
  salt: string; // 64-hex, hides the leaf preimage
  createdLedger: number;
};

export type BorrowerRecord = {
  subject: string; // 64-hex
  address: string;
  repaid: number;
  defaults: number;
  salt: string; // 64-hex
};

export interface Store {
  ensureUser(subject: string, address: string, ledger: number): Promise<UserRecord>;
  getUser(subject: string): Promise<UserRecord | null>;
  setBalance(subject: string, stroops: string): Promise<void>;
  allUserSubjects(): Promise<string[]>;
  // passport issuer
  ensureBorrower(subject: string, address: string): Promise<BorrowerRecord>;
  setBorrower(subject: string, repaid: number, defaults: number): Promise<void>;
  getBorrower(subject: string): Promise<BorrowerRecord | null>;
  allBorrowerSubjects(): Promise<string[]>;
  // auth challenge (short-lived)
  putChallenge(address: string, nonce: string, ttlSeconds: number): Promise<void>;
  takeChallenge(address: string): Promise<string | null>;
  // debounce: acquire `key` for `ttlSeconds`; true only if not already held.
  acquireOnce(key: string, ttlSeconds: number): Promise<boolean>;
  // authoritative cumulative withdrawals per user (ahead of the event index),
  // so reconcile can never re-credit a balance a withdrawal already spent.
  addWithdrawn(subject: string, amount: bigint): Promise<void>;
  getWithdrawn(subject: string): Promise<bigint>;
  // ---- lending pool: a SECOND private book (lender positions) ----
  ensureLender(subject: string, address: string, ledger: number): Promise<UserRecord>;
  getLender(subject: string): Promise<UserRecord | null>;
  setLenderBalance(subject: string, stroops: string): Promise<void>;
  allLenderSubjects(): Promise<string[]>;
  addLenderWithdrawn(subject: string, amount: bigint): Promise<void>;
  getLenderWithdrawn(subject: string): Promise<bigint>;
}

function randHex(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Upstash-backed store ----

class RedisStore implements Store {
  constructor(private r: Redis) {}

  async ensureUser(subject: string, address: string, ledger: number): Promise<UserRecord> {
    const existing = await this.getUser(subject);
    if (existing) return existing;
    const rec: UserRecord = {
      subject,
      address,
      balance: "0",
      salt: randHex(),
      createdLedger: ledger,
    };
    await this.r.hset(`user:${subject}`, rec as unknown as Record<string, unknown>);
    await this.r.sadd("users", subject);
    return rec;
  }
  async getUser(subject: string): Promise<UserRecord | null> {
    const h = await this.r.hgetall<Record<string, string>>(`user:${subject}`);
    if (!h || !h.subject) return null;
    return {
      subject: h.subject,
      address: h.address,
      balance: String(h.balance ?? "0"),
      salt: h.salt,
      createdLedger: Number(h.createdLedger ?? 0),
    };
  }
  async setBalance(subject: string, stroops: string): Promise<void> {
    await this.r.hset(`user:${subject}`, { balance: stroops });
  }
  async allUserSubjects(): Promise<string[]> {
    return (await this.r.smembers("users")) ?? [];
  }

  async ensureBorrower(subject: string, address: string): Promise<BorrowerRecord> {
    const existing = await this.getBorrower(subject);
    if (existing) return existing;
    const rec: BorrowerRecord = { subject, address, repaid: 0, defaults: 0, salt: randHex() };
    await this.r.hset(`borrower:${subject}`, rec as unknown as Record<string, unknown>);
    await this.r.sadd("borrowers", subject);
    return rec;
  }
  async setBorrower(subject: string, repaid: number, defaults: number): Promise<void> {
    await this.r.hset(`borrower:${subject}`, { repaid, defaults });
  }
  async getBorrower(subject: string): Promise<BorrowerRecord | null> {
    const h = await this.r.hgetall<Record<string, string>>(`borrower:${subject}`);
    if (!h || !h.subject) return null;
    return {
      subject: h.subject,
      address: h.address,
      repaid: Number(h.repaid ?? 0),
      defaults: Number(h.defaults ?? 0),
      salt: h.salt,
    };
  }
  async allBorrowerSubjects(): Promise<string[]> {
    return (await this.r.smembers("borrowers")) ?? [];
  }

  async putChallenge(address: string, nonce: string, ttl: number): Promise<void> {
    await this.r.set(`chal:${address}`, nonce, { ex: ttl });
  }
  async takeChallenge(address: string): Promise<string | null> {
    const key = `chal:${address}`;
    const v = await this.r.get<string>(key);
    if (v) await this.r.del(key);
    return v ?? null;
  }
  async acquireOnce(key: string, ttl: number): Promise<boolean> {
    const ok = await this.r.set(`lock:${key}`, "1", { nx: true, ex: ttl });
    return ok === "OK";
  }
  async addWithdrawn(subject: string, amount: bigint): Promise<void> {
    await this.r.hincrby(`user:${subject}`, "withdrawn", Number(amount));
  }
  async getWithdrawn(subject: string): Promise<bigint> {
    const v = await this.r.hget<number | string>(`user:${subject}`, "withdrawn");
    return BigInt(v ?? 0);
  }
  // lender book (pool) — same structure, `lender:` keys.
  async ensureLender(subject: string, address: string, ledger: number): Promise<UserRecord> {
    const existing = await this.getLender(subject);
    if (existing) return existing;
    const rec: UserRecord = { subject, address, balance: "0", salt: randHex(), createdLedger: ledger };
    await this.r.hset(`lender:${subject}`, rec as unknown as Record<string, unknown>);
    await this.r.sadd("lenders", subject);
    return rec;
  }
  async getLender(subject: string): Promise<UserRecord | null> {
    const h = await this.r.hgetall<Record<string, string>>(`lender:${subject}`);
    if (!h || !h.subject) return null;
    return {
      subject: h.subject,
      address: h.address,
      balance: String(h.balance ?? "0"),
      salt: h.salt,
      createdLedger: Number(h.createdLedger ?? 0),
    };
  }
  async setLenderBalance(subject: string, stroops: string): Promise<void> {
    await this.r.hset(`lender:${subject}`, { balance: stroops });
  }
  async allLenderSubjects(): Promise<string[]> {
    return (await this.r.smembers("lenders")) ?? [];
  }
  async addLenderWithdrawn(subject: string, amount: bigint): Promise<void> {
    await this.r.hincrby(`lender:${subject}`, "withdrawn", Number(amount));
  }
  async getLenderWithdrawn(subject: string): Promise<bigint> {
    const v = await this.r.hget<number | string>(`lender:${subject}`, "withdrawn");
    return BigInt(v ?? 0);
  }
}

// ---- in-memory dev fallback (per-process; not durable) ----

class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private borrowers = new Map<string, BorrowerRecord>();
  private chal = new Map<string, { nonce: string; exp: number }>();

  async ensureUser(subject: string, address: string, ledger: number) {
    let u = this.users.get(subject);
    if (!u) {
      u = { subject, address, balance: "0", salt: randHex(), createdLedger: ledger };
      this.users.set(subject, u);
    }
    return u;
  }
  async getUser(subject: string) {
    return this.users.get(subject) ?? null;
  }
  async setBalance(subject: string, stroops: string) {
    const u = this.users.get(subject);
    if (u) u.balance = stroops;
  }
  async allUserSubjects() {
    return [...this.users.keys()];
  }
  async ensureBorrower(subject: string, address: string) {
    let b = this.borrowers.get(subject);
    if (!b) {
      b = { subject, address, repaid: 0, defaults: 0, salt: randHex() };
      this.borrowers.set(subject, b);
    }
    return b;
  }
  async setBorrower(subject: string, repaid: number, defaults: number) {
    const b = this.borrowers.get(subject);
    if (b) {
      b.repaid = repaid;
      b.defaults = defaults;
    }
  }
  async getBorrower(subject: string) {
    return this.borrowers.get(subject) ?? null;
  }
  async allBorrowerSubjects() {
    return [...this.borrowers.keys()];
  }
  async putChallenge(address: string, nonce: string, ttl: number) {
    this.chal.set(address, { nonce, exp: Date.now() + ttl * 1000 });
  }
  async takeChallenge(address: string) {
    const c = this.chal.get(address);
    this.chal.delete(address);
    if (!c || c.exp < Date.now()) return null;
    return c.nonce;
  }
  private locks = new Map<string, number>();
  async acquireOnce(key: string, ttl: number) {
    const now = Date.now();
    const exp = this.locks.get(key);
    if (exp && exp > now) return false;
    this.locks.set(key, now + ttl * 1000);
    return true;
  }
  private withdrawn = new Map<string, bigint>();
  async addWithdrawn(subject: string, amount: bigint) {
    this.withdrawn.set(subject, (this.withdrawn.get(subject) ?? 0n) + amount);
  }
  async getWithdrawn(subject: string) {
    return this.withdrawn.get(subject) ?? 0n;
  }
  private lenders = new Map<string, UserRecord>();
  private lenderWithdrawn = new Map<string, bigint>();
  async ensureLender(subject: string, address: string, ledger: number) {
    let l = this.lenders.get(subject);
    if (!l) {
      l = { subject, address, balance: "0", salt: randHex(), createdLedger: ledger };
      this.lenders.set(subject, l);
    }
    return l;
  }
  async getLender(subject: string) {
    return this.lenders.get(subject) ?? null;
  }
  async setLenderBalance(subject: string, stroops: string) {
    const l = this.lenders.get(subject);
    if (l) l.balance = stroops;
  }
  async allLenderSubjects() {
    return [...this.lenders.keys()];
  }
  async addLenderWithdrawn(subject: string, amount: bigint) {
    this.lenderWithdrawn.set(subject, (this.lenderWithdrawn.get(subject) ?? 0n) + amount);
  }
  async getLenderWithdrawn(subject: string) {
    return this.lenderWithdrawn.get(subject) ?? 0n;
  }
}

let _store: Store | null = null;

/** The singleton store: Upstash when configured, else in-memory (dev). */
export function getStore(): Store {
  if (_store) return _store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    _store = new RedisStore(new Redis({ url, token }));
  } else {
    if (process.env.VERCEL) {
      console.warn(
        "[store] No Redis env configured — using in-memory store. Data will NOT persist across serverless invocations. Provision Upstash/KV.",
      );
    }
    _store = new MemoryStore();
  }
  return _store;
}

export function isDurable(): boolean {
  return Boolean(
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
  );
}
