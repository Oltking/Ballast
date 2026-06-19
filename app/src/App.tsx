import { useState } from "react";
import PublicVerifier from "./pages/PublicVerifier.tsx";
import HolderInclusion from "./pages/HolderInclusion.tsx";
import IssuerDashboard from "./pages/IssuerDashboard.tsx";

type Tab = "verify" | "holder" | "issuer";

const TABS: { id: Tab; label: string }[] = [
  { id: "verify", label: "Public verifier" },
  { id: "holder", label: "Holder inclusion" },
  { id: "issuer", label: "Issuer dashboard" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("verify");

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>⚓ Ballast</h1>
          <span className="tag">solvency you can verify, not trust</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === "verify" && <PublicVerifier />}
      {tab === "holder" && <HolderInclusion />}
      {tab === "issuer" && <IssuerDashboard />}
    </div>
  );
}
