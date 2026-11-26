import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves the demo from /<repo>/; everything else from the root.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.API_PROXY_TARGET ?? "http://localhost:8080",
    },
  },
});
