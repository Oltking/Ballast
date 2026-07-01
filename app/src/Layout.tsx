// Shared Ballast shell for every route: brand header, top nav, live-network
// chip, and footer. Pages render into <Outlet/>.
import { Link, NavLink, Outlet } from "react-router-dom";
import { useWallet } from "./lib/wallet-context.tsx";
import { shortHex } from "./lib/format.ts";

const nav = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

export default function Layout() {
  const { address, connecting, connect, disconnect } = useWallet();
  return (
    <div className="app">
      <header className="top">
        <Link to="/" className="brand">
          <h1>
            <span className="mark">⚓</span>
            Ballast
          </h1>
          <span className="tag">the bank that proves it</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="netchip">
            <span className="live" />
            Live · Stellar testnet
          </span>
          <nav className="tabs" aria-label="Sections">
            <NavLink to="/" end className={nav}>
              Home
            </NavLink>
            <NavLink to="/app" className={nav}>
              Dashboard
            </NavLink>
            <NavLink to="/verify" className={nav}>
              Proof
            </NavLink>
          </nav>
          {address ? (
            <span className="wallet-chip">
              <span className="wallet-dot" />
              {shortHex(address, 6, 6)}
              <button className="linklike" onClick={disconnect}>
                Disconnect
              </button>
            </span>
          ) : (
            <button className="btn small" onClick={() => void connect()} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </header>

      <Outlet />

      <footer className="foot">
        <span>
          Ballast is a provably-solvent custodian: a zero-knowledge proof shows reserves cover every
          customer, without revealing the private ledger. Research prototype · testnet only.
        </span>
        <span>
          <Link to="/operator">For operators</Link> ·{" "}
          <a href="https://stellar.org" target="_blank" rel="noreferrer">
            Built on Stellar
          </a>
        </span>
      </footer>
    </div>
  );
}
