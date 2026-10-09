import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createWebDevProxy, webDevOriginGuard } from "./scripts/web/dev-proxy.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode, command }) => {
  const webDevelopment = mode === "web" && command === "serve";
  const webEnvironment = loadEnv(mode, ".", "SUCANVAS_WEB_");
  const webBackend = webEnvironment.SUCANVAS_WEB_BACKEND || "http://127.0.0.1:18742";
  return ({
  plugins: [react(), ...(webDevelopment ? [webDevOriginGuard()] : [])],
  define: webDevelopment ? { "import.meta.env.SUCANVAS_WEB_DEV_BACKEND": JSON.stringify(new URL(webBackend).origin) } : {},
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
    port: mode === "web" ? Number(webEnvironment.SUCANVAS_WEB_DEV_PORT || 1422) : 1420,
    strictPort: true,
    host: mode === "web" ? "127.0.0.1" : host || false,
    proxy: webDevelopment ? createWebDevProxy(webBackend, webEnvironment.SUCANVAS_WEB_CA_FILE) : undefined,
    hmr: mode !== "web" && host
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
});
});
