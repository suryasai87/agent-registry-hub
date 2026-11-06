/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Monolith build: emit into ../app/static so FastAPI serves the bundle (/assets + SPA fallback).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Hashed bundles go to /_app (not Vite's default /assets): /assets/<urn> is the SPA's entity-page route.
  build: { outDir: "../app/static", emptyOutDir: true, chunkSizeWarningLimit: 900, assetsDir: "_app" },
  // Local API: the FastAPI app (python app.py). Port 8765 by default; override with API_PORT.
  server: { port: 5173, proxy: { "/api": `http://localhost:${(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.API_PORT ?? "8765"}` } },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
