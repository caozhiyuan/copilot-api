import type { SettingsSection } from "@/hooks/use-active-section"
import { AnimatedGradientText } from "@/components/ui/animated-gradient-text"
import { cn } from "@/lib/utils"

export type SettingsNavigationProps = {
  sections: Array<SettingsSection>
  activeSection: string
  onSectionClick: (id: string) => void
  className?: string
}

/**
 * Sticky sidebar navigation for settings page.
 * Uses AnimatedGradientText for active section highlight.
 */
export function SettingsNavigation({
  sections,
  activeSection,
  onSectionClick,
  className,
}: SettingsNavigationProps) {
  return (
    <nav
      className={cn(
        "sticky top-6 space-y-1 rounded-lg border bg-card p-2",
        className
      )}
      aria-label="Settings sections"
    >
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Settings
      </div>
      {sections.map((section) => {
        const isActive = activeSection === section.id
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSectionClick(section.id)}
            className={cn(
              "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive && "bg-accent/50"
            )}
            aria-current={isActive ? "page" : undefined}
            aria-controls={section.id}
          >
            {isActive ? (
              <AnimatedGradientText
                speed={1.5}
                colorFrom="#9E7AFF"
                colorTo="#FE8BBB"
                className="font-medium"
              >
                {section.label}
              </AnimatedGradientText>
            ) : (
              <span className="text-muted-foreground">{section.label}</span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
