import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // The server only accepts a 127.0.0.1 or localhost Host, so the proxy rewrites it.
    proxy: { "/api": { target: "http://127.0.0.1:4310", changeOrigin: true } },
  },
  build: { chunkSizeWarningLimit: 1000 },
});
