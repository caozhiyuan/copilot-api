import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"

import "@/index.css"
import App from "@/App"
import { SystemThemeSync } from "@/components/system-theme-sync"
import { Toaster } from "@/components/ui/sonner"
import { AdminTokenProvider } from "@/lib/admin-token"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AdminTokenProvider>
      <SystemThemeSync />
      <HashRouter>
        <App />
      </HashRouter>
      <Toaster />
    </AdminTokenProvider>
  </StrictMode>
)
