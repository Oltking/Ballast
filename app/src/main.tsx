import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Buffer } from "buffer";
import App from "./App.tsx";
import "./styles.css";

// @stellar/stellar-sdk expects a global Buffer in the browser.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
