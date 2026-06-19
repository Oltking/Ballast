// Wallet connect + write path (deposit / withdraw / attest). Uses Stellar
// Wallets Kit to sign; the browser never sees a secret key.
import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from "@creit.tech/stellar-wallets-kit";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL, VAULT_ID } from "./config.ts";

const server = new rpc.Server(RPC_URL);

let kit: StellarWalletsKit | null = null;
function getKit(): StellarWalletsKit {
  kit ??= new StellarWalletsKit({
    network: WalletNetwork.TESTNET,
    selectedWalletId: FREIGHTER_ID,
    modules: allowAllModules(),
  });
  return kit;
}

export async function connectWallet(): Promise<string> {
  const k = getKit();
  return new Promise<string>((resolve, reject) => {
    void k.openModal({
      onWalletSelected: async (option) => {
        try {
          k.setWallet(option.id);
          const { address } = await k.getAddress();
          resolve(address);
        } catch (e) {
          reject(e);
        }
      },
      onClosed: () => reject(new Error("wallet selection cancelled")),
    });
  });
}

/** Build → simulate/prepare → sign (wallet) → send → poll. Returns tx hash. */
export async function invoke(
  caller: string,
  method: string,
  args: xdr.ScVal[] = [],
  contractId: string = VAULT_ID,
): Promise<string> {
  const account = await server.getAccount(caller);
  const contract = new Contract(contractId);
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(built);
  const { signedTxXdr } = await getKit().signTransaction(prepared.toXDR(), {
    address: caller,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  const signed = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
  }
  // Poll for completion.
  let got = await server.getTransaction(sent.hash);
  for (let i = 0; i < 15 && got.status === "NOT_FOUND"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    got = await server.getTransaction(sent.hash);
  }
  if (got.status === "FAILED") {
    throw new Error(`tx failed on-chain: ${sent.hash}`);
  }
  return sent.hash;
}
