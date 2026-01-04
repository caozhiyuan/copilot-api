import { NavLink, Outlet } from "react-router-dom"
import { MenuIcon } from "lucide-react"

import { AnimatedGradientText } from "@/components/ui/animated-gradient-text"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { TokenDialog } from "@/components/token-dialog"
import { MotionToggle } from "@/components/motion-toggle"
import { ThemeToggle } from "@/components/theme-toggle"

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

export function AppShell(): React.JSX.Element {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="bg-background/70 sticky top-0 z-50 border-b backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <div className="md:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Open navigation">
                  <MenuIcon className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72">
                <SheetHeader>
                  <SheetTitle>
                    <AnimatedGradientText className="text-base font-semibold">
                      Copilot API Admin
                    </AnimatedGradientText>
                  </SheetTitle>
                </SheetHeader>
                <nav className="mt-4 flex flex-col gap-3">
                  <NavItem to="/accounts" label="Accounts" />
                  <NavItem to="/requests" label="Requests" />
                </nav>
              </SheetContent>
            </Sheet>
          </div>

          <div className="min-w-0">
            <AnimatedGradientText className="text-base font-semibold">
              Copilot API Admin
            </AnimatedGradientText>
          </div>

          <nav className="hidden items-center gap-5 md:flex">
            <NavItem to="/accounts" label="Accounts" />
            <NavItem to="/requests" label="Requests" />
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <MotionToggle />
            <ThemeToggle />
            <TokenDialog />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
