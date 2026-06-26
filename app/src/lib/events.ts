// Real on-chain activity for a customer address.
//
// The vault emits `#[contractevent]`s on every flow: Deposit{from,amount,
// net_custodied} and WithdrawUser{to,amount,net_custodied}, with the customer
// address as an indexed topic. We fetch them straight from the RPC's event
// index — so "when did I deposit?" is answered by ledger truth (close time +
// tx hash), not by anything we store. Nothing here is simulated.
//
// Testnet RPC keeps only a rolling window of events (~7 days). Outside it, or on
// any error, we degrade gracefully to an empty list — the optimistic local
// record in customer.ts still covers the session.

import { rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { RPC_URL, VAULT_ID } from "./config.ts";
import { addressArg } from "./stellar.ts";

const server = new rpc.Server(RPC_URL, { allowHttp: false });

export type ChainEvent = {
  kind: "deposit" | "withdraw";
  amount: string; // stroops
  netCustodied?: string; // running total after the flow, if present
  ledger: number;
  ts: number; // ledger close time (ms)
  tx: string;
};

// Pull the i128 stroop fields out of the decoded event payload, whether the SDK
// hands us a struct (object) or a positional vec.
function readPayload(value: xdr.ScVal): { amount: string; netCustodied?: string } {
  const v = scValToNative(value) as unknown;
  if (v && typeof v === "object") {
    if (Array.isArray(v)) {
      return { amount: String(v[0] ?? "0"), netCustodied: v[1] != null ? String(v[1]) : undefined };
    }
    const o = v as Record<string, unknown>;
    return {
      amount: String(o.amount ?? "0"),
      netCustodied: o.net_custodied != null ? String(o.net_custodied) : undefined,
    };
  }
  return { amount: String(v ?? "0") };
}

/**
 * Fetch this address's deposit/withdraw history from the chain event index.
 * Filters by `["*", <address>]` so it matches any 2-topic vault event whose
 * second topic is this account — i.e. Deposit.from and WithdrawUser.to — and
 * reads the kind from the event-name topic rather than assuming its casing.
 */
export async function fetchAccountEvents(address: string): Promise<ChainEvent[]> {
  let latest: number;
  try {
    latest = (await server.getLatestLedger()).sequence;
  } catch {
    return [];
  }
  const addrTopic = addressArg(address).toXDR("base64");
  const byTx = new Map<string, ChainEvent>();

  // The testnet RPC's event retention is short, and — annoyingly — it returns an
  // *empty* page (not an error) when startLedger is past the floor, so a single
  // large lookback can silently miss recent events. Probe several windows from
  // wide to narrow and merge (dedupe by tx+ledger) so we catch whichever one the
  // node actually answers.
  const lookbacks = [17_000, 11_000, 7_000, 3_500];
  for (const back of lookbacks) {
    let startLedger = Math.max(latest - back, 1);
    try {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: [VAULT_ID], topics: [["*", addrTopic]] }],
        limit: 100,
      });
      collect(res.events, byTx);
    } catch (e) {
      // startLedger too old → retry once from the floor the RPC reports.
      const m = /ledger range:\s*(\d+)/.exec(e instanceof Error ? e.message : String(e));
      if (m && Number(m[1]) > startLedger) {
        startLedger = Number(m[1]);
        try {
          const res = await server.getEvents({
            startLedger,
            filters: [{ type: "contract", contractIds: [VAULT_ID], topics: [["*", addrTopic]] }],
            limit: 100,
          });
          collect(res.events, byTx);
        } catch {
          /* skip this window */
        }
      }
    }
  }

  return [...byTx.values()].sort((a, b) => b.ts - a.ts);
}

function collect(events: Awaited<ReturnType<rpc.Server["getEvents"]>>["events"], byTx: Map<string, ChainEvent>) {
  for (const ev of events) {
    let name = "";
    try {
      name = String(scValToNative(ev.topic[0])).toLowerCase();
    } catch {
      continue;
    }
    const kind: ChainEvent["kind"] | null = name.includes("deposit")
      ? "deposit"
      : name.includes("withdraw")
        ? "withdraw"
        : null;
    if (!kind) continue;
    const { amount, netCustodied } = readPayload(ev.value);
    byTx.set(`${ev.txHash}-${ev.ledger}`, {
      kind,
      amount,
      netCustodied,
      ledger: ev.ledger,
      ts: Date.parse(ev.ledgerClosedAt),
      tx: ev.txHash,
    });
  }
}
