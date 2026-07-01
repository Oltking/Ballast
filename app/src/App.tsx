import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./Layout.tsx";
import Landing from "./pages/Landing.tsx";
import CustomerHub from "./pages/CustomerHub.tsx";
import PublicVerifier from "./pages/PublicVerifier.tsx";
import IssuerDashboard from "./pages/IssuerDashboard.tsx";

// Ballast — "the bank that proves it". Unified neobank:
//   /          landing (public)
//   /app       customer hub (account · passport · loans · activity)
//   /verify    public proof-of-reserves verifier (anyone)
//   /operator  operator console
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<CustomerHub />} />
          <Route path="/verify" element={<PublicVerifier />} />
          <Route path="/operator" element={<IssuerDashboard />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
