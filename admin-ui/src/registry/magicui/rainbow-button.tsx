import * as React from "react"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface RainbowButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  className?: string
}

export const RainbowButton = React.forwardRef<HTMLButtonElement, RainbowButtonProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          buttonVariants(),
          "bg-gradient-to-r from-fuchsia-500 via-amber-400 to-cyan-400 text-white",
          "hover:opacity-90",
          className
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)

RainbowButton.displayName = "RainbowButton"
