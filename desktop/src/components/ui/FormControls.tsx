import type { ReactNode } from 'react'
import { primaryButtonClass } from '../../lib/button-styles'

export { primaryButtonClass }

export const formFieldBaseClass =
  'w-full min-w-0 rounded-lg border border-line bg-surface text-[13px] text-ink placeholder-ink-faint transition-colors focus:border-brand/50 focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-55'

export const formFieldClass = `${formFieldBaseClass} px-3 py-2`

export const formSelectBaseClass = `${formFieldBaseClass} cursor-pointer text-left [text-align-last:left]`

export const formSelectClass = `${formSelectBaseClass} px-3 py-2`

export const secondaryButtonClass =
  'rounded-lg border border-line bg-surface text-ink-soft transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 disabled:cursor-not-allowed disabled:opacity-40'

export const segmentedGroupClass =
  'grid grid-cols-3 gap-1 rounded-lg border border-line bg-sunken p-1'

export function segmentedButtonClass(isActive: boolean, extra = '') {
  return `${extra} min-h-8 rounded-md px-2 text-[12px] font-medium transition-colors ${
    isActive ?
      'bg-surface text-ink shadow-sm ring-1 ring-line-soft'
    : 'text-ink-soft hover:bg-surface/70 hover:text-ink'
  }`
}

export function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-soft">
      {label}
      {children}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full ring-1 ring-inset ring-line transition-colors focus:outline-none focus:ring-2 focus:ring-brand/35 ${checked ? 'bg-brand ring-brand' : 'bg-sunken'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)] ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

export function CheckboxSwitch({
  ariaLabel,
  checked,
  disabled,
  id,
  onChange,
}: {
  ariaLabel?: string
  checked: boolean
  disabled?: boolean
  id?: string
  onChange: (checked: boolean) => void
}) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative block h-5 w-9 rounded-full bg-sunken ring-1 ring-inset ring-line transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-emerald-500 peer-checked:ring-emerald-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-disabled:opacity-40"
      />
    </span>
  )
}

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line-soft py-3.5 last:border-0 dark:border-white/10">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {description && (
          <div className="text-[12px] text-ink-faint mt-0.5 leading-relaxed">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}
