// Server-side Stellar access for the custodian backend: the operator signer
// (holds OPERATOR_SECRET, signs withdraw_user / predicate management) and the
// event reader that reconciles the private book from on-chain vault flows.
//
// The operator secret NEVER leaves the server. Set it as the `OPERATOR_SECRET`
// env var on the deployment (the funded admin/operator S... key).

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
export const VAULT_ID =
  process.env.VAULT_CONTRACT_ID || "CAULRHZ5WKYXHQJTF3BC3AV4QHOIEPDN5LIGDBWS6UOJ76YLLPT3VONR";
export const REGISTRY_ID =
  process.env.REGISTRY_ID || "CDJ7GMWC2253BCPQVH2N37RKVXTLBKH7QGIAKF54DQEYJI4Q6X7M4I2D";
export const LOANBOOK_ID =
  process.env.LOANBOOK_ID || "CBIUJ4CFSUIZNZWRUPDD5E3TL2G5VYQO6KF26J6DKS2MBU3LBIS4KRTB";

export const server = new rpc.Server(RPC_URL, { allowHttp: false });

export function hasOperatorKey(): boolean {
  return Boolean(process.env.OPERATOR_SECRET);
}

export function operatorKeypair(): Keypair {
  const s = process.env.OPERATOR_SECRET;
  if (!s) throw new Error("OPERATOR_SECRET not configured");
  return Keypair.fromSecret(s.trim());
}

export function operatorAddress(): string {
  return operatorKeypair().publicKey();
}

export const i128 = (v: bigint | string): xdr.ScVal => nativeToScVal(v.toString(), { type: "i128" });
export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
export const addr = (g: string): xdr.ScVal => new Address(g).toScVal();
export const bytes = (hex: string): xdr.ScVal =>
  xdr.ScVal.scvBytes(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** Build, simulate/assemble, sign with the operator key, submit, and poll. */
export async function invokeAsOperator(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const kp = operatorKeypair();
  const acct = await server.getAccount(kp.publicKey());
  const src = new Account(acct.accountId(), acct.sequenceNumber());
  const contract = new Contract(contractId);
  const built = new TransactionBuilder(src, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`submit failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
  }
  // Poll for completion.
  let got = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && got.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== "SUCCESS") {
    throw new Error(`tx ${sent.hash} status ${got.status}`);
  }
  return sent.hash;
}

/** Read-only view via simulation (no signer). */
export async function readView(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const a = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const tx = new TransactionBuilder(a, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : null;
}

export type VaultFlow = { kind: "deposit" | "withdraw"; address: string; amount: bigint };

/** Read every Deposit{from}/WithdrawUser{to} the vault has emitted (across a few
 *  retention windows) so the book can be reconciled to live on-chain custody. */
export async function getVaultFlows(): Promise<VaultFlow[]> {
  const latest = (await server.getLatestLedger()).sequence;
  const byKey = new Map<string, VaultFlow>();
  for (const back of [120_000, 60_000, 17_000, 7_000]) {
    let startLedger = Math.max(latest - back, 1);
    try {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: [VAULT_ID] }],
        limit: 1000,
      });
      for (const ev of res.events) {
        let name = "";
        try {
          name = String(scValToNative(ev.topic[0])).toLowerCase();
        } catch {
          continue;
        }
        const kind = name.includes("deposit")
          ? "deposit"
          : name.includes("withdrawuser") || name.includes("withdraw_user")
            ? "withdraw"
            : null;
        if (!kind) continue;
        // topic[1] is the indexed address (Deposit.from / WithdrawUser.to).
        let address = "";
        try {
          address = String(scValToNative(ev.topic[1]));
        } catch {
          continue;
        }
        const payload = scValToNative(ev.value) as Record<string, unknown> | unknown[];
        const amount = Array.isArray(payload)
          ? BigInt(String(payload[0] ?? 0))
          : BigInt(String((payload as Record<string, unknown>).amount ?? 0));
        byKey.set(`${ev.txHash}-${ev.ledger}-${ev.id}`, { kind, address, amount });
      }
    } catch {
      // window too old / transient — skip
    }
  }
  return [...byKey.values()];
}

/** Net on-chain custody per address = Σ deposits − Σ user-withdrawals (≥ 0). */
export async function netCustodyByAddress(): Promise<Map<string, bigint>> {
  const flows = await getVaultFlows();
  const net = new Map<string, bigint>();
  for (const f of flows) {
    const cur = net.get(f.address) ?? 0n;
    net.set(f.address, cur + (f.kind === "deposit" ? f.amount : -f.amount));
  }
  for (const [k, v] of net) if (v < 0n) net.set(k, 0n);
  return net;
}

export async function latestLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}

// ---- loan-book (on-chain credit history source) ----

/** Discover every borrower the loan-book has touched, from its event topics. */
export async function getLoanbookBorrowers(): Promise<Set<string>> {
  const latest = (await server.getLatestLedger()).sequence;
  const out = new Set<string>();
  for (const back of [120_000, 60_000, 17_000, 7_000]) {
    const startLedger = Math.max(latest - back, 1);
    try {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: [LOANBOOK_ID] }],
        limit: 1000,
      });
      for (const ev of res.events) {
        try {
          out.add(String(scValToNative(ev.topic[1])));
        } catch {
          /* skip */
        }
      }
    } catch {
      /* window too old / transient */
    }
  }
  return out;
}

export type LoanStats = { repaid: number; defaults: number };

/** Authoritative per-borrower credit stats from the loan-book contract. */
export async function loanbookStats(address: string): Promise<LoanStats> {
  const s = (await readView(LOANBOOK_ID, "stats", [addr(address)])) as Record<string, unknown> | null;
  return {
    repaid: Number(s?.repaid_count ?? 0),
    defaults: Number(s?.default_count ?? 0),
  };
}
