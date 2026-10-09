import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react()],
  resolve: mode === "web" ? {
    alias: Object.fromEntries([
      "@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/webview",
      "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener",
    ].map((name) => [name, new URL("./src/web/bridge.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")])),
  } : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    proxy: mode === "web" ? {
      "/api": { target: "http://127.0.0.1:18740", ws: true, headers: { origin: "http://127.0.0.1:18740" } },
      "/v1": { target: "http://127.0.0.1:18740", headers: { origin: "http://127.0.0.1:18740" } },
    } : undefined,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll("\\", "/");
          if (!moduleId.includes("/node_modules/")) return undefined;
          if (
            moduleId.includes("/@xyflow/")
            || moduleId.includes("/zustand/")
            || moduleId.includes("/classcat/")
          ) {
            return "canvas-vendor";
          }
          if (moduleId.includes("/lucide-react/")) return "icons-vendor";
          if (moduleId.includes("/@tauri-apps/")) return "tauri-vendor";
          if (
            moduleId.includes("/react/")
            || moduleId.includes("/react-dom/")
            || moduleId.includes("/scheduler/")
          ) {
            return "react-vendor";
          }
          return "vendor";
        },
      },
    },
  },
}));
