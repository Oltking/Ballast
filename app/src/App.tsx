import { useEffect, useState } from "react";
import PublicVerifier from "./pages/PublicVerifier.tsx";
import CustomerDashboard from "./pages/CustomerDashboard.tsx";
import IssuerDashboard from "./pages/IssuerDashboard.tsx";

type Tab = "verify" | "account" | "issuer";

const TABS: { id: Tab; label: string }[] = [
  { id: "verify", label: "Is my money safe?" },
  { id: "account", label: "My account" },
  { id: "issuer", label: "For operators" },
];

const isTab = (s: string): s is Tab => s === "verify" || s === "account" || s === "issuer";
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#/, "");
  return isTab(h) ? h : "verify";
};

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);

  // Deep-linkable surfaces: keep the URL hash and the active tab in sync, and
  // respond to back/forward navigation.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selectTab = (t: Tab) => {
    setTab(t);
    if (tabFromHash() !== t) window.location.hash = t;
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>
            <span className="mark">⚓</span>
            Ballast
          </h1>
          <span className="tag">proof your money is backed</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="netchip">
            <span className="live" />
            Live · Stellar testnet
          </span>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "active" : ""}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {tab === "verify" && <PublicVerifier />}
      {tab === "account" && <CustomerDashboard />}
      {tab === "issuer" && <IssuerDashboard />}

      <footer className="foot">
        <span>
          Ballast independently checks that a custodian's reserves cover every customer — using a
          zero-knowledge proof, so the private ledger stays private. Research prototype · testnet only.
        </span>
        <span>
          <a href="https://stellar.org" target="_blank" rel="noreferrer">
            Built on Stellar
          </a>
        </span>
      </footer>
    </div>
  );
}
