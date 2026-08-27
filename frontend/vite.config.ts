import { defineConfig } from "vite";
// The Solid JSX compiler plugin. It used to be published as "vite-plugin-solid"; that name was
// retired and the package is now "@solidjs/vite-plugin", which is what Solid 2 requires.
import solid from "@solidjs/vite-plugin";
import { fileURLToPath, URL } from "node:url";

/**
 * Vite configuration.
 *
 * Everything runs inside Docker, so the dev server has to listen on 0.0.0.0 (every network
 * interface). If it listened on the default 127.0.0.1 it would only be reachable from *inside*
 * the container, and your browser on the host machine could not open it.
 */
export default defineConfig({
  plugins: [solid()],

  resolve: {
    alias: {
      // "~/api/client" is nicer to read than "../../api/client".
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    // Bind mounts on Linux sometimes miss file-change events; polling is the reliable fallback.
    watch: { usePolling: true, interval: 300 },
    // Hot Module Replacement talks back to the browser over a websocket; tell it the host port.
    hmr: { clientPort: 3000 },
    proxy: {
      /*
       * Anything the browser requests under /api is forwarded to the backend container.
       * "backend" is the service name in docker-compose.yml, which Docker resolves to its IP.
       * This is why the app also works when VITE_API_BASE is left unset: it then uses the
       * relative path "/api" and this proxy does the rest.
       */
      "/api": {
        target: "http://backend:8080",
        changeOrigin: true,
        /*
         * Also forward WebSocket upgrades. Plain HTTP proxying does not cover them: a WebSocket
         * starts life as an HTTP request carrying an `Upgrade` header, and without this flag the
         * dev server answers that request itself instead of passing it through — so the chat
         * stream at /api/chat/ws would connect in production and mysteriously fail under
         * `make up`. Server-sent events are ordinary HTTP responses and never needed this.
         */
        ws: true,
      },
    },
  },
});
