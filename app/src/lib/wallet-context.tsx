// One shared "umbrella" for wallet connection. Connect once (in any section)
// and every route/section sees the same account — no re-prompting when you move
// from Account to Loans to the Credit Passport. The connected address is kept in
// sessionStorage so a page refresh remembers you're connected (a later signed
// action may still re-prompt the wallet, but the app never makes you click
// "Connect" again just to navigate).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { connectWallet, getWalletNetwork } from "./wallet.ts";
import { NETWORK_PASSPHRASE } from "./config.ts";

const STORAGE_KEY = "ballast:wallet-address";

interface WalletContextValue {
  address: string | null;
  /** Network passphrase the connected wallet is actually set to ("" if unknown). */
  walletNet: string;
  connecting: boolean;
  /** True when the wallet is pointed at a network other than this testnet app. */
  wrongNetwork: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Re-read the wallet's network (after the user switches it to Testnet). */
  refreshNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletNet, setWalletNet] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Re-hydrate a prior session so navigation/refresh doesn't force a re-connect.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        setAddress(saved);
        // Best-effort: restore the wallet's network so the wrong-network guard
        // still works after a refresh (getWalletNetwork swallows its own errors).
        void getWalletNetwork().then(setWalletNet);
      }
    } catch {
      /* sessionStorage unavailable — ignore */
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const a = await connectWallet(); // opens the wallet-kit modal
      setAddress(a);
      try {
        sessionStorage.setItem(STORAGE_KEY, a);
      } catch {
        /* ignore */
      }
      setWalletNet(await getWalletNetwork());
    } catch {
      // User cancelled the modal, or the wallet errored — leave disconnected.
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setWalletNet("");
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshNetwork = useCallback(async () => {
    setWalletNet(await getWalletNetwork());
  }, []);

  const wrongNetwork = !!walletNet && walletNet !== NETWORK_PASSPHRASE;

  return (
    <WalletContext.Provider
      value={{ address, walletNet, connecting, wrongNetwork, connect, disconnect, refreshNetwork }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
