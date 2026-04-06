import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type FloatingSaveButtonProps = {
  saving: boolean
  canSave: boolean
  onSave: () => void
  className?: string
}

/**
 * Fixed position save button in the bottom right corner.
 * Only rendered when there are unsaved changes.
 */
export function FloatingSaveButton({
  saving,
  canSave,
  onSave,
  className,
}: FloatingSaveButtonProps) {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        "fixed bottom-6 right-6 z-50",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-300",
        className,
      )}
    >
      <Button
        type="button"
        size="lg"
        onClick={onSave}
        disabled={!canSave}
        className="shadow-lg"
      >
        {saving
          ? t("settingsPage.saveButton.saving")
          : t("settingsPage.saveButton.saveChanges")}
      </Button>
    </div>
  )
}
