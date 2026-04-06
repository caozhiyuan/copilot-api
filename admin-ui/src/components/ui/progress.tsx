import * as React from "react"
import { motion, useSpring, useTransform } from "motion/react"

import { useMotionPreference } from "@/lib/motion-preference"
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
  style,
  ...props
}: ProgressProps) {
  const { effective } = useMotionPreference()

  const safeValue = Number.isFinite(value) ? clamp(value, 0, 100) : 0

  const animated = effective !== "off"
  const shimmer = effective === "magic"
  const speed = effective === "subtle" ? "4s" : "2.2s"

  // Spring-animated width for fluid fill
  const springValue = useSpring(safeValue, {
    damping: 30,
    stiffness: 120,
    mass: 0.8,
  })
  const widthPercent = useTransform(springValue, (v) => `${v}%`)

  // Update spring target when value changes
  React.useEffect(() => {
    springValue.set(safeValue)
  }, [safeValue, springValue])

  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuenow={Math.round(safeValue)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "bg-muted/60 relative h-1.5 w-full overflow-hidden rounded-full ring-1 ring-border/40",
        className
      )}
      style={{
        ...style,
        "--speed": speed,
      } as React.CSSProperties}
      {...props}
    >
      <motion.div
        data-slot="progress-indicator"
        className={cn(
          "relative h-full rounded-full",
          "[container-type:inline-size] overflow-hidden",
          // Magic UI vibe: animated multi-stop gradient (same tokens used by RainbowButton)
          "bg-[linear-gradient(90deg,var(--color-1),var(--color-5),var(--color-3),var(--color-4),var(--color-2))] bg-[length:200%_100%]",
          animated ? "animate-rainbow" : undefined,
          shimmer
            ? "before:absolute before:inset-y-0 before:left-0 before:w-3/5 before:rounded-full before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent)] before:opacity-50 before:animate-shimmer-slide before:content-['']"
            : undefined,
          // subtle glow
          "dark:shadow-[0_0_12px_rgba(255,255,255,0.12)] shadow-[0_0_8px_rgba(0,0,0,0.06)]",
          indicatorClassName
        )}
        style={{
          width: animated ? widthPercent : `${safeValue}%`,
        }}
      />
    </div>
  )
}

export { Progress }
