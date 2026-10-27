/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard is served by the ShipFlow API at /ui/, so it calls the API on
// the same origin (no CORS, no stored credentials in URLs). In development the
// Vite server proxies the API routes to a running ShipFlow API.
const API = process.env.SHIPFLOW_API_URL ?? "http://127.0.0.1:8000";
const API_PATHS = ["/whoami", "/ready", "/health", "/projects", "/releases", "/deploy", "/rollback"];

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    // The shared config schema lives in ../cli/lib (pure TypeScript).
    fs: { allow: [path.resolve(import.meta.dirname, "..")] },
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, { target: API, changeOrigin: false }])),
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022", chunkSizeWarningLimit: 700 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
