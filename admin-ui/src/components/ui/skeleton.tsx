import * as React from "react"

import { useMotionPreference } from "@/lib/motion-preference"
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  const { effective } = useMotionPreference()

  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "rounded-md",
        effective === "off"
          ? "bg-muted"
          : "relative overflow-hidden bg-muted before:absolute before:inset-0 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-foreground/[0.07] before:to-transparent before:animate-[skeleton-shimmer_1.8s_ease-in-out_infinite] dark:before:via-foreground/[0.05]",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
