import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api/admin": {
        target: "http://localhost:4141",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // Avoid triggering admin-api cross-origin checks during local dev.
            proxyReq.removeHeader("origin")
          })
        },
      },
    },
  },
  build: {
    outDir: "../dist/admin",
    emptyOutDir: true,
  },
})
