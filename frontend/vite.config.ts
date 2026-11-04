import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // On-chain tools: Vercel functions in production; `pnpm tools` locally.
    proxy: { "/api": process.env.TOOLS_URL ?? "http://127.0.0.1:4021" },
  },
});
