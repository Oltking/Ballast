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
  const out: ChainEvent[] = [];

  // Walk back in chunks until retention rejects the start ledger.
  let startLedger = Math.max(latest - 17_000, 1);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await server.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: [VAULT_ID], topics: [["*", addrTopic]] }],
        limit: 100,
      });
      for (const ev of res.events) {
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
        out.push({
          kind,
          amount,
          netCustodied,
          ledger: ev.ledger,
          ts: Date.parse(ev.ledgerClosedAt),
          tx: ev.txHash,
        });
      }
      break; // reached the page; we read the whole retained window in one pass
    } catch (e) {
      // startLedger too old → pull the window forward and retry once.
      const m = /ledger range:\s*(\d+)/.exec(e instanceof Error ? e.message : String(e));
      if (m) {
        const oldest = Number(m[1]);
        if (oldest > startLedger) {
          startLedger = oldest;
          continue;
        }
      }
      return out; // any other error: hand back whatever we have (possibly none)
    }
  }

  return out.sort((a, b) => b.ts - a.ts);
}
