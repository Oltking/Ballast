// Ballast customer hub (/app) — the neobank dashboard. Co-equal sections:
// Account (deposit/withdraw/backed/counted), Credit Passport, and Loans, plus
// Activity within Account. Section nav keeps it one cohesive place.
// (Loans is a starter placeholder — the real borrow/repay UI wires to /api/loan.)
import { useState } from "react";
import CustomerDashboard from "./CustomerDashboard.tsx";
import CreditPassport from "./CreditPassport.tsx";

type Section = "account" | "passport" | "loans";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "passport", label: "Credit Passport" },
  { id: "loans", label: "Loans" },
];

export default function CustomerHub() {
  const [section, setSection] = useState<Section>("account");

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "center", margin: "18px 0 6px" }}>
        <nav className="tabs" aria-label="Dashboard sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? "active" : ""}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>

      {section === "account" && <CustomerDashboard />}
      {section === "passport" && <CreditPassport />}
      {section === "loans" && (
        <section className="panel" style={{ maxWidth: 640, margin: "20px auto", textAlign: "center" }}>
          <h3>Loans</h3>
          <p style={{ color: "var(--muted)" }}>
            Borrow, repay, and build your on-chain credit standing — which powers your Credit
            Passport. Coming to your dashboard.
          </p>
        </section>
      )}
    </main>
  );
}
