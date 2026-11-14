import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the stateless proxy (server/main.py) runs on :8000.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  define: { global: "globalThis" }, // some wallet-selector deps reference Node's `global`
});
