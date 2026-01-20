import { forwardRef, type ReactNode } from "react"
import { BorderBeam } from "@/components/ui/border-beam"
import { MagicCard } from "@/components/ui/magic-card"
import { cn } from "@/lib/utils"

export type SettingsSectionCardProps = {
  id: string
  isActive: boolean
  children: ReactNode
  className?: string
}

/**
 * Settings section wrapper with MagicCard effect and BorderBeam on active state.
 * Wraps existing card components to add visual effects.
 */
export const SettingsSectionCard = forwardRef<HTMLDivElement, SettingsSectionCardProps>(
  ({ id, isActive, children, className }, ref) => {
    return (
      <div
        ref={ref}
        data-section-id={id}
        className={cn("relative scroll-mt-6", className)}
      >
        <MagicCard
          className="rounded-xl overflow-hidden"
          gradientSize={200}
          gradientOpacity={0.6}
        >
          {isActive && (
            <BorderBeam
              size={50}
              duration={6}
              colorFrom="#9E7AFF"
              colorTo="#FE8BBB"
              borderWidth={2}
              className="opacity-70"
            />
          )}
          <div className="relative">
            {children}
          </div>
        </MagicCard>
      </div>
    )
  }
)

SettingsSectionCard.displayName = "SettingsSectionCard"
