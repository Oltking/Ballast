// Read-only chain access: simulate vault view calls and decode the results.
// Reads never need a wallet or a signature — this is the "trust the ledger, not
// our server" path that powers the public verifier.

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL, SIM_SOURCE, VAULT_ID } from "./config";

const server = new rpc.Server(RPC_URL, { allowHttp: false });

/** Simulate a read-only contract call and return its decoded native value. */
export async function readView(
  method: string,
  args: xdr.ScVal[] = [],
  contractId: string = VAULT_ID,
): Promise<unknown> {
  const contract = new Contract(contractId);
  const source = new Account(SIM_SOURCE, "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`${method}: empty result`);
  return scValToNative(retval);
}

export function addressArg(g: string): xdr.ScVal {
  return new Address(g).toScVal();
}

// ---- Decoded view shapes ----

export type Attestation = {
  liabilities_root: Uint8Array;
  reserves: bigint;
  net_custodied: bigint;
  ratio_bps: number;
  epoch: number;
  ledger: number;
  reserves_checked: boolean;
  floor_checked: boolean;
  solvent: boolean;
};

export type VaultConfig = {
  admin: string;
  operator: string;
  reserve_token: string;
  verifier: string;
  image_id: Uint8Array;
  mode: number | { tag: string }; // enum: 0 AttestationOnly / 1 Enforced
  max_staleness_ledgers: number;
  min_ratio_bps: number;
  domain: Uint8Array;
};

export type VaultState = {
  config: VaultConfig;
  reserves: bigint;
  netCustodied: bigint;
  epoch: number;
  attestation: Attestation | null;
  fresh: boolean;
  maxOperatorWithdrawable: bigint;
  latestLedger: number;
};

function modeNum(mode: VaultConfig["mode"]): number {
  if (typeof mode === "number") return mode;
  // scValToNative may decode a unit enum to its variant name.
  return mode?.tag === "Enforced" ? 1 : 0;
}

export function isEnforced(cfg: VaultConfig): boolean {
  return modeNum(cfg.mode) === 1;
}

/** One round trip-ish snapshot of everything the public verifier needs. */
export async function loadVaultState(): Promise<VaultState> {
  const [config, reserves, netCustodied, epoch, attestation, fresh, maxW, ledger] =
    await Promise.all([
      readView("config") as Promise<VaultConfig>,
      readView("reserves") as Promise<bigint>,
      readView("net_custodied") as Promise<bigint>,
      readView("epoch") as Promise<number>,
      readView("latest_attestation") as Promise<Attestation | null>,
      readView("attestation_fresh") as Promise<boolean>,
      readView("max_operator_withdrawable") as Promise<bigint>,
      server.getLatestLedger(),
    ]);

  return {
    config,
    reserves: BigInt(reserves ?? 0),
    netCustodied: BigInt(netCustodied ?? 0),
    epoch: Number(epoch ?? 0),
    attestation: attestation ?? null,
    fresh: Boolean(fresh),
    maxOperatorWithdrawable: BigInt(maxW ?? 0),
    latestLedger: ledger.sequence,
  };
}

export { server };
