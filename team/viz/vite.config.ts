import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the Ditto API is proxied with the credentials from the
// environment (DITTO_BASIC_AUTH), as the nginx of the image does in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.DITTO_URL ?? "http://localhost:8080",
        changeOrigin: true,
        headers: { Authorization: `Basic ${process.env.DITTO_BASIC_AUTH ?? ""}` },
      },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
