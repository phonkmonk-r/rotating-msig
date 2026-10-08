import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  // Relative asset paths: the same build is served by the CLI over HTTP and loaded from disk by the desktop app.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5174,
    // Development only: forwards the API to a running `rotation-signer`. Its origin check would refuse the dev
    // server's origin, so the proxy drops that header.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7373",
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (request) => request.removeHeader("origin")),
      },
    },
  },
});
