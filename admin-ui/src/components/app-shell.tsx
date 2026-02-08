import { NavLink, Outlet } from "react-router-dom"
import { MenuIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnimatedGradientText } from "@/components/ui/animated-gradient-text"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { LocaleToggle } from "@/components/locale-toggle"
import { ThemeToggle } from "@/components/theme-toggle"
import { TokenDialog } from "@/components/token-dialog"
import { cn } from "@/lib/utils"

function NavItem({
  to,
  label,
}: {
  to: string
  label: string
}): React.JSX.Element {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "text-sm font-medium transition-colors hover:text-foreground",
          isActive ? "text-foreground" : "text-muted-foreground"
        )
      }
    >
      {label}
    </NavLink>
  )
}

const NAV_ITEMS = [
  { to: "/accounts", labelKey: "nav.accounts" },
  { to: "/requests", labelKey: "nav.requests" },
  { to: "/models", labelKey: "nav.models" },
  { to: "/settings", labelKey: "nav.settings" },
] as const

function NavList(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <>
      {NAV_ITEMS.map((item) => (
        <NavItem key={item.to} to={item.to} label={t(item.labelKey)} />
      ))}
    </>
  )
}

export function AppShell(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="bg-background/70 sticky top-0 z-50 border-b backdrop-blur">
        <div className="flex w-full items-center gap-3 px-4 py-3 lg:px-6">
          <div className="md:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("nav.openNavigation")}>
                  <MenuIcon className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72">
                <SheetHeader>
                  <SheetTitle>
                    <AnimatedGradientText className="text-base font-semibold">
                      {t("app.title")}
                    </AnimatedGradientText>
                  </SheetTitle>
                </SheetHeader>
                <nav className="mt-4 flex flex-col gap-3">
                  <NavList />
                </nav>
              </SheetContent>
            </Sheet>
          </div>

          <div className="min-w-0">
            <AnimatedGradientText className="text-base font-semibold">
              {t("app.title")}
            </AnimatedGradientText>
          </div>

          <nav className="hidden items-center gap-5 md:flex">
            <NavList />
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <LocaleToggle />
            <ThemeToggle />
            <TokenDialog />
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-4 lg:px-6 lg:py-6">
        <Outlet />
      </main>
    </div>
  )
}
