// Ballast customer hub (/app) — the neobank dashboard. Co-equal sections:
// Account (deposit/withdraw/backed/counted), Credit Passport, and Loans, plus
// Activity within Account. Section nav keeps it one cohesive place.
// (Loans wires the real borrow/repay UI to /api/loan and the loan-book.)
import { useState } from "react";
import CustomerDashboard from "./CustomerDashboard.tsx";
import CreditPassport from "./CreditPassport.tsx";
import Loans from "./Loans.tsx";

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
      {section === "loans" && <Loans />}
    </main>
  );
}
