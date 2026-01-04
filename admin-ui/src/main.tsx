import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThemeProvider } from "next-themes"

import "@/index.css"
import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { AdminTokenProvider } from "@/lib/admin-token"
import { MotionPreferenceProvider } from "@/lib/motion-preference"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AdminTokenProvider>
        <MotionPreferenceProvider>
          <HashRouter>
            <App />
          </HashRouter>
          <Toaster />
        </MotionPreferenceProvider>
      </AdminTokenProvider>
    </ThemeProvider>
  </StrictMode>
)
