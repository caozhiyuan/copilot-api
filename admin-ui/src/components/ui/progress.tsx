import * as React from "react"

import { cn } from "@/lib/utils"

export type ProgressProps = React.ComponentProps<"div"> & {
  /**
   * Progress value in the range 0-100.
   */
  value?: number
  /**
   * Extra classes applied to the inner indicator.
   */
  indicatorClassName?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function Progress({
  value = 0,
  className,
  indicatorClassName,
  ...props
}: ProgressProps) {
  const safeValue = Number.isFinite(value) ? clamp(value, 0, 100) : 0

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuenow={Math.round(safeValue)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "bg-muted relative h-1 w-full overflow-hidden rounded-full",
        className
      )}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          "bg-primary h-full transition-[width] duration-300 ease-out",
          indicatorClassName
        )}
        style={{ width: `${safeValue}%` }}
      />
    </div>
  )
}

export { Progress }
