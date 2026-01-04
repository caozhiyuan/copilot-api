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
        "bg-muted rounded-md",
        effective === "off" ? undefined : "animate-pulse",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
