// Smoke: exercise the same RPC read + decode path the UI uses, in Node.
import {
  Account, BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const PASS = "Test SDF Network ; September 2015";
const VAULT = "CC2FR7RGP55JUI2NWZBYWSJOJ2WO3FCCXEL75VVSJBEHFEMWUZ32FY6N";
const SRC = "GAKDJF75JLWEOGIUIHJLCZKL2IEHELKTVXOHD4L6AGHAQT4YZE4MWROT";
const server = new rpc.Server(RPC_URL);

async function read(method) {
  const c = new Contract(VAULT);
  const tx = new TransactionBuilder(new Account(SRC, "0"), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(c.call(method)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(method + ": " + sim.error);
  return scValToNative(sim.result.retval);
}

for (const m of ["config", "reserves", "net_custodied", "epoch", "attestation_fresh", "max_operator_withdrawable", "latest_attestation"]) {
  const v = await read(m);
  console.log(m, "=>", typeof v === "object" ? JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x) : v);
}
console.log("READS_OK");
