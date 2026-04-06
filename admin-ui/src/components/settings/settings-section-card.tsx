import type { CSSProperties, ReactNode } from "react"
import { forwardRef } from "react"

import { cn } from "@/lib/utils"

export type SettingsSectionCardProps = {
  id: string
  isActive: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/**
 * Settings section wrapper card.
 * Subtle ring highlight on the active (scrolled-to) section.
 */
export const SettingsSectionCard = forwardRef<HTMLDivElement, SettingsSectionCardProps>(
  ({ id, isActive, children, className, style }, ref) => {
    return (
      <div
        ref={ref}
        id={id}
        data-section-id={id}
        className={cn(
          "scroll-mt-6 rounded-xl transition-shadow",
          "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards",
          isActive && "ring-1 ring-primary/30",
          className,
        )}
        style={style}
      >
        {children}
      </div>
    )
  }
)

SettingsSectionCard.displayName = "SettingsSectionCard"
