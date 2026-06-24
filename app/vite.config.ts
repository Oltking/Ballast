import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Buffer is used by @stellar/stellar-sdk; ensure it resolves in the browser.
export default defineConfig({
  plugins: [react()],
  define: {
    global: "globalThis",
  },
  build: {
    // The Stellar SDK is inherently large; we've split it into its own cached
    // chunk above, so the remaining size is expected — keep the log clean.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Split the heavy Stellar SDK / wallet kit out of the app bundle so the
        // UI paints without waiting on vendor code, and the chunks cache well.
        manualChunks: {
          stellar: ["@stellar/stellar-sdk", "@creit.tech/stellar-wallets-kit"],
        },
      },
    },
  },
});
