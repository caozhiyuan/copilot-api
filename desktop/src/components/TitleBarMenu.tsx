import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import desktopPackage from '../../package.json'

type ElectronAppRegionStyle = CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag'
}

const noDragRegionStyle: ElectronAppRegionStyle = { WebkitAppRegion: 'no-drag' }

interface MenuAction {
  type: 'item'
  label: string
  onClick: () => void
}

interface MenuSeparator {
  type: 'separator'
}

type MenuEntry = MenuAction | MenuSeparator

interface MenuConfig {
  key: string
  label: string
  entries: MenuEntry[]
}

interface TitleBarMenuProps {
  onOpenSettings?: () => void
  onOpenAuthConfig?: () => void
  onCheckUpdates?: () => void
}

export default function TitleBarMenu({
  onOpenSettings,
  onOpenAuthConfig,
  onCheckUpdates,
}: TitleBarMenuProps) {
  const { t } = useLanguage()
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [showAbout, setShowAbout] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const openAbout = () => {
    setShowAbout(true)
  }

  const menus: MenuConfig[] = [
    {
      key: 'file',
      label: t('menu.file'),
      entries: [
        {
          type: 'item',
          label: t('menu.fileSettings'),
          onClick: () => onOpenSettings?.(),
        },
        ...(onOpenAuthConfig ?
          [
            {
              type: 'item' as const,
              label: t('menu.fileAuthConfig'),
              onClick: onOpenAuthConfig,
            },
          ]
        : []),
        { type: 'separator' },
        {
          type: 'item',
          label: t('menu.fileQuit'),
          onClick: () => window.electronAPI.windowQuit(),
        },
      ],
    },
    {
      key: 'view',
      label: t('menu.view'),
      entries: [
        {
          type: 'item',
          label: t('menu.viewReload'),
          onClick: () => window.electronAPI.windowReload(),
        },
      ],
    },
    {
      key: 'help',
      label: t('menu.help'),
      entries: [
        {
          type: 'item',
          label: t('updates.check'),
          onClick: () => onCheckUpdates?.(),
        },
        { type: 'item', label: t('menu.helpAbout'), onClick: openAbout },
        {
          type: 'item',
          label: t('menu.helpDocs'),
          onClick: () =>
            window.electronAPI.openUrl(
              'https://github.com/caozhiyuan/copilot-api#readme',
            ),
        },
      ],
    },
  ]

  useEffect(() => {
    if (!openMenu) return
    const handleOutside = (e: MouseEvent) => {
      if (
        containerRef.current
        && !containerRef.current.contains(e.target as Node)
      ) {
        setOpenMenu(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [openMenu])

  useEffect(() => {
    if (!showAbout) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAbout(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [showAbout])

  const handleMenuClick = (key: string) => {
    setOpenMenu((prev) => (prev === key ? null : key))
  }

  const handleAction = (action: MenuAction) => {
    setOpenMenu(null)
    action.onClick()
  }

  return (
    <>
      <div
        ref={containerRef}
        className="flex items-center"
        style={noDragRegionStyle}
      >
        {menus.map((menu) => (
          <div key={menu.key} className="relative">
            <button
              onClick={() => handleMenuClick(menu.key)}
              onMouseEnter={() => {
                if (openMenu) setOpenMenu(menu.key)
              }}
              className={`px-2.5 py-1 text-[13px] rounded-md transition-colors ${
                openMenu === menu.key ?
                  'bg-sunken text-ink'
                : 'text-ink-soft hover:text-ink hover:bg-sunken'
              }`}
            >
              {menu.label}
            </button>

            {openMenu === menu.key && (
              <div className="absolute left-0 top-full mt-0.5 bg-surface border border-line rounded-lg shadow-lg z-50 min-w-[180px] overflow-hidden py-1">
                {menu.entries.map((entry, index) => {
                  if (entry.type === 'separator') {
                    return (
                      <div
                        key={`sep-${index}`}
                        className="h-px bg-line-soft my-1"
                      />
                    )
                  }
                  return (
                    <button
                      key={entry.label}
                      onClick={() => handleAction(entry)}
                      className="flex items-center w-full px-3 py-1.5 text-[13px] text-ink-soft hover:bg-sunken hover:text-ink transition-colors text-left"
                    >
                      {entry.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {showAbout && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 dark:bg-black/70"
          onClick={() => setShowAbout(false)}
          style={noDragRegionStyle}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onClick={(e) => e.stopPropagation()}
            className="w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-line bg-elevated shadow-xl dark:shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-center justify-between border-b border-line-soft bg-surface px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-[10px] font-bold text-white">
                  CA
                </div>
                <div>
                  <div
                    id="about-title"
                    className="text-[14px] font-semibold text-ink"
                  >
                    Copilot API
                  </div>
                  <div className="text-[12px] text-ink-faint">
                    {t('menu.helpAbout')}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowAbout(false)}
                aria-label={t('menu.helpAbout')}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="px-4 py-4">
              <div className="flex items-center justify-between rounded-lg border border-line bg-sunken px-3 py-2.5">
                <span className="text-[13px] text-ink-soft">
                  {t('menu.aboutVersion')}
                </span>
                <span className="text-[13px] font-semibold text-ink">
                  v{desktopPackage.version}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
