import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThemeProvider } from "next-themes"

import "@/index.css"
import "@/lib/i18n"
import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { AdminTokenProvider } from "@/lib/admin-token"
import { LocalePreferenceProvider } from "@/lib/locale-preference"
import { MotionPreferenceProvider } from "@/lib/motion-preference"

const rootElement = document.querySelector("#root")
if (!rootElement) throw new Error("Root element not found")

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <LocalePreferenceProvider>
        <AdminTokenProvider>
          <MotionPreferenceProvider>
            <HashRouter>
              <App />
            </HashRouter>
            <Toaster />
          </MotionPreferenceProvider>
        </AdminTokenProvider>
      </LocalePreferenceProvider>
    </ThemeProvider>
  </StrictMode>
)
