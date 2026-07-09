import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// 開発時: vite(5173) がビュー配信、/ws と /api は drawzu サーバー(4989)へ中継
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:4989", ws: true },
      "/api": { target: "http://localhost:4989" },
    },
  },
});
