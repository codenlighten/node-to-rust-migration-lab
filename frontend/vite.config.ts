import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dev server proxies to the gateway, exactly like nginx does in the container.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy: { "/api": "http://localhost:8080", "/__gateway": "http://localhost:8080" } },
});
