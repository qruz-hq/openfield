import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// In dev the page is served through the Openfield server on 4317, which proxies everything
// outside /api and /files here. The HMR socket skips the proxy and talks to Vite directly.
// Vite sits on 4318, beside the server, so it never clashes with another project's 5173 (§0.16).

const VITE_PORT = 4318;

const SERVER_ORIGIN = `http://127.0.0.1:${process.env.OPENFIELD_PORT || 4317}`;
/** Set by the server's dev proxy (apps/server/src/http/spa.ts). */
const PROXIED = "x-openfield-proxied";

/**
 * A page opened on Vite's port directly has no session token, so nothing on it works. Send it to the
 * server instead, and don't print Vite's own URL: the server prints the one to open.
 */
function openThroughServer(): Plugin {
  return {
    name: "openfield:open-through-server",
    apply: "serve",
    configureServer(server) {
      server.printUrls = () => {};
      server.middlewares.use((req, res, next) => {
        if (req.headers["sec-fetch-dest"] !== "document" || req.headers[PROXIED]) return next();
        res.statusCode = 307;
        res.setHeader("location", `${SERVER_ORIGIN}${req.url ?? "/"}`);
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), openThroughServer()],
  server: {
    host: "127.0.0.1",
    port: VITE_PORT,
    strictPort: true,
    hmr: { protocol: "ws", host: "127.0.0.1", port: VITE_PORT, clientPort: VITE_PORT },
  },
  preview: { host: "127.0.0.1", port: VITE_PORT, strictPort: true },
  build: {
    outDir: "dist",
    target: "es2023",
    sourcemap: true,
    // React, zod and the router are most of the one chunk, and all load on the first screen.
    // The app is served from this computer, so a bigger file costs nothing to download.
    chunkSizeWarningLimit: 1024,
  },
});
