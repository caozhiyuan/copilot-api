import type { ReactNode } from 'react'

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 dark:border-white/10 dark:bg-[#101014] dark:focus:border-blue-400/40 dark:focus:bg-[#17171d] dark:focus:ring-blue-500/30'

export const selectClass = `${fieldClass} cursor-pointer`
export const inputClass = `${fieldClass} placeholder-ink-faint disabled:cursor-not-allowed disabled:opacity-55 dark:disabled:bg-[#0d0d11]`
export const segmentedGroupClass =
  'grid grid-cols-3 gap-1 rounded-lg border border-line bg-sunken p-1 dark:border-white/10 dark:bg-[#0f0f13]'

export function segmentedButtonClass(isActive: boolean, extra = '') {
  return `${extra} min-h-8 rounded-md px-2 text-[12px] font-medium transition-colors ${
    isActive ?
      'bg-surface text-ink shadow-sm dark:bg-[#262630] dark:text-white dark:shadow-[0_1px_0_rgba(255,255,255,0.06),0_8px_18px_rgba(0,0,0,0.24)]'
    : 'text-ink-soft hover:bg-surface/70 hover:text-ink dark:hover:bg-white/10 dark:hover:text-white'
  }`
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full ring-1 ring-inset ring-line-soft transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 dark:ring-white/10 dark:focus:ring-blue-500/35 ${checked ? 'bg-accent-strong dark:bg-blue-500' : 'bg-sunken dark:bg-[#34343b]'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)] ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
      />
    </button>
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

export const IconGeneral = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const IconStartup = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)

export const IconNetwork = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 0 20" />
    <path d="M12 2a15.3 15.3 0 0 0 0 20" />
  </svg>
)

export const IconSun = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>
)

export const IconMoon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
)

export const IconMonitor = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </svg>
)

export const IconSecurity = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)
