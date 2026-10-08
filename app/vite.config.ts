import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Use packages/core sources directly, without a separate build step.
    conditions: ["source"],
  },
  server: {
    port: 5173,
    // Safe{Wallet} fetches manifest.json cross-origin when loading a custom Safe App.
    headers: { "Access-Control-Allow-Origin": "*" },
  },
  preview: {
    headers: { "Access-Control-Allow-Origin": "*" },
  },
});
