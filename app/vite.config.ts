import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Buffer is used by @stellar/stellar-sdk; ensure it resolves in the browser.
export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
  },
});
