import * as React from "react"

import { cn } from "@/lib/utils"

export type SwitchProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> & {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

function SwitchComponent(
  {
    className,
    checked,
    defaultChecked,
    onCheckedChange,
    disabled,
    onClick,
    type = "button",
    ...props
  }: SwitchProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
): React.JSX.Element {
  const isControlled = checked !== undefined
  const [internalChecked, setInternalChecked] = React.useState<boolean>(
    defaultChecked ?? false,
  )
  const isChecked = isControlled ? checked : internalChecked

  function handleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    onClick?.(event)
    if (event.defaultPrevented || disabled) return
    const next = !isChecked
    if (!isControlled) setInternalChecked(next)
    onCheckedChange?.(next)
  }

  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={Boolean(isChecked)}
      data-state={isChecked ? "checked" : "unchecked"}
      data-disabled={disabled ? "true" : "false"}
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-input bg-input/30 shadow-xs transition-[color,box-shadow] outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        isChecked ? "bg-primary border-primary" : "bg-input/30",
        className,
      )}
      onClick={handleClick}
      disabled={disabled}
      {...props}
    >
      <span
        data-state={isChecked ? "checked" : "unchecked"}
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-background shadow-sm transition-transform",
          isChecked ? "translate-x-5" : "translate-x-1",
        )}
      />
    </button>
  )
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(SwitchComponent)
Switch.displayName = "Switch"

export { Switch }
