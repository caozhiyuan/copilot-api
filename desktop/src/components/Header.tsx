import {
  lazy,
  Suspense,
  useState,
  useRef,
  useEffect,
  type CSSProperties,
} from 'react'
import AppUpdatePanel from './AppUpdatePanel'
import TitleBarMenu from './TitleBarMenu'
import WindowControls from './WindowControls'
import { useLanguage } from '../contexts/LanguageContext'

const SettingsModal = lazy(() => import('./SettingsModal'))
const ProviderManagementModal = lazy(() => import('./ProviderManagementModal'))

type ElectronAppRegionStyle = CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag'
}

const dragRegionStyle: ElectronAppRegionStyle = { WebkitAppRegion: 'drag' }
const noDragRegionStyle: ElectronAppRegionStyle = { WebkitAppRegion: 'no-drag' }

const isMac =
  typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin'
const titleBarPaddingClass = isMac ? 'pl-20 pr-4' : 'px-4'

const IconRestart = () => (
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
    <path d="M21 12a9 9 0 0 1-15.3 6.36" />
    <path d="M3 12A9 9 0 0 1 18.3 5.64" />
    <path d="M18 2v4h-4" />
  </svg>
)

const IconStop = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

interface HeaderProps {
  onChangeAuth?: () => void
  onOpenAuthConfig?: () => void
  onRestart?: () => void
  onStop?: () => void
  onSettingsClose?: () => void
  onProvidersClose?: () => void
  isRunning?: boolean
  isRestarting?: boolean
}

export default function Header({
  onChangeAuth,
  onOpenAuthConfig,
  onRestart,
  onStop,
  onSettingsClose,
  onProvidersClose,
  isRunning,
  isRestarting,
}: HeaderProps) {
  const { t } = useLanguage()
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'general' | 'updates'>(
    'general',
  )
  const [showProviders, setShowProviders] = useState(false)
  const [showSettingsMenu, setShowSettingsMenu] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const showServerStatus = Boolean(onStop)

  useEffect(() => {
    if (!showSettingsMenu) return
    const handleOutside = (e: MouseEvent) => {
      if (
        settingsMenuRef.current
        && !settingsMenuRef.current.contains(e.target as Node)
      ) {
        setShowSettingsMenu(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [showSettingsMenu])

  const handleSettingsAction = () => {
    if (onChangeAuth) {
      setShowSettingsMenu((v) => !v)
      return
    }

    openSettings()
  }

  const openSettings = () => {
    setSettingsSection('general')
    setShowSettings(true)
  }

  return (
    <>
      <div
        className={`flex shrink-0 items-center border-b border-line-soft bg-surface h-11 ${titleBarPaddingClass}`}
        style={dragRegionStyle}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-accent-strong rounded-md flex items-center justify-center dark:bg-[#4f94f8]">
              <span className="text-white text-[9px] font-bold">CA</span>
            </div>
            <span className="text-sm font-bold text-ink">Copilot API</span>
          </div>
          <div className="w-px h-4 bg-line" />
          <TitleBarMenu
            onOpenSettings={openSettings}
            onOpenAuthConfig={onOpenAuthConfig ?? onChangeAuth}
            onCheckUpdates={() => {
              setSettingsSection('updates')
              setShowSettings(true)
            }}
          />
        </div>

        <div
          className="ml-auto flex items-center gap-2"
          style={noDragRegionStyle}
        >
          {isRunning && onRestart && (
            <button
              onClick={onRestart}
              disabled={isRestarting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px] border border-line text-ink-soft rounded-md hover:bg-sunken disabled:opacity-50 transition-colors"
            >
              <IconRestart />
              {isRestarting ? t('header.restarting') : t('header.restart')}
            </button>
          )}

          {isRunning && onStop && (
            <button
              onClick={onStop}
              disabled={isRestarting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px] border border-red-200 text-red-500 rounded-md hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-500/15 disabled:opacity-50 transition-colors"
            >
              <IconStop />
              {t('header.stop')}
            </button>
          )}

          {isRunning && !isRestarting ?
            <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-2.5 py-1 dark:bg-green-500/15 dark:border-green-500/25">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-[13px] font-semibold text-green-700 dark:text-green-400">
                {t('header.running')}
              </span>
            </div>
          : showServerStatus ?
            <div className="flex items-center gap-1.5 bg-yellow-50 border border-yellow-200 rounded-full px-2.5 py-1 dark:bg-yellow-500/15 dark:border-yellow-500/25">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
              <span className="text-[13px] font-semibold text-yellow-700 dark:text-yellow-400">
                {isRestarting ? t('header.restarting') : t('header.notStarted')}
              </span>
            </div>
          : null}

          {onProvidersClose && (
            <button
              type="button"
              onClick={() => setShowProviders(true)}
              className="rounded-lg px-2 py-1.5 text-xs text-ink-soft hover:bg-sunken"
            >
              {t('providers.title')}
            </button>
          )}
          <div className="relative" ref={settingsMenuRef}>
            <button
              onClick={handleSettingsAction}
              className="p-1.5 text-ink-faint hover:text-ink hover:bg-sunken rounded-md transition-colors"
              title={t('header.settings')}
            >
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
            </button>

            {showSettingsMenu && onChangeAuth && (
              <div className="absolute right-0 top-full mt-1.5 bg-surface border border-line rounded-xl shadow-lg z-10 min-w-[170px] overflow-hidden">
                <button
                  onClick={() => {
                    setShowSettingsMenu(false)
                    openSettings()
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-ink-soft hover:bg-sunken transition-colors text-left"
                >
                  {t('header.appSettings')}
                </button>
                {onChangeAuth && (
                  <button
                    onClick={() => {
                      setShowSettingsMenu(false)
                      onChangeAuth()
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-ink-soft hover:bg-sunken transition-colors text-left border-t border-line-soft"
                  >
                    {t('header.changeAuth')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {isMac ? null : <WindowControls />}
      </div>

      <AppUpdatePanel compact />

      <Suspense fallback={null}>
        {showSettings && (
          <SettingsModal
            initialSection={settingsSection}
            checkForUpdatesOnOpen={settingsSection === 'updates'}
            onClose={() => {
              setShowSettings(false)
              onSettingsClose?.()
            }}
          />
        )}
        {showProviders && (
          <ProviderManagementModal
            onClose={() => {
              setShowProviders(false)
              onProvidersClose?.()
            }}
            serverRunning={isRunning}
          />
        )}
      </Suspense>
    </>
  )
}
