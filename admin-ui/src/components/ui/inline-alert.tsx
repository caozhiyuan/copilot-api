import * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type InlineAlertVariant = "info" | "success" | "warning" | "error"

export interface InlineAlertProps {
  variant?: InlineAlertVariant
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
  className?: string
}

function iconForVariant(variant: InlineAlertVariant): React.JSX.Element {
  if (variant === "success") return <CircleCheckIcon className="size-4" />
  if (variant === "warning") return <TriangleAlertIcon className="size-4" />
  if (variant === "error") return <OctagonXIcon className="size-4" />
  return <InfoIcon className="size-4" />
}

function classNameForVariant(variant: InlineAlertVariant): string {
  switch (variant) {
    case "success":
      return "border-emerald-500/20 bg-emerald-500/10"
    case "warning":
      return "border-amber-500/20 bg-amber-500/10"
    case "error":
      return "border-destructive/20 bg-destructive/10"
    default:
      return "border-border/60 bg-muted/30"
  }
}

export function InlineAlert({
  variant = "info",
  title,
  description,
  actionLabel,
  onAction,
  className,
}: InlineAlertProps): React.JSX.Element {
  const icon = iconForVariant(variant)

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3",
        classNameForVariant(variant),
        className
      )}
    >
      <div className="mt-0.5 shrink-0 text-foreground">{icon}</div>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-5">{title}</div>
        {description ? (
          <div className="text-muted-foreground mt-1 text-sm leading-5">
            {description}
          </div>
        ) : null}
      </div>

      {actionLabel && onAction ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAction}
          className="shrink-0"
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
