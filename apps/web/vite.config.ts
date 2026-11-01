import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("apps/web"),
  build: { outDir: resolve("dist/web"), emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:3210", ws: true } },
  },
});
