import { useState, useRef, useEffect } from 'react'
import SettingsModal from './SettingsModal'
import { useLanguage } from '../contexts/LanguageContext'

interface HeaderProps {
  username?: string
  onLogout?: () => void
  onStop?: () => void
  isRunning?: boolean
}

export default function Header({ username, onLogout, onStop, isRunning }: HeaderProps) {
  const { t } = useLanguage()
  const [showSettings, setShowSettings] = useState(false)
  const [showLogout, setShowLogout] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showLogout) return
    const handleOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowLogout(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [showLogout])

  return (
    <>
      {/* Placeholder for the macOS traffic lights that keeps the window draggable */}
      <div
        className="h-9 bg-white shrink-0"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ WebkitAppRegion: 'drag' } as any}
      />
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-white">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-[#0f172a] rounded-md flex items-center justify-center">
            <span className="text-white text-[9px] font-bold">CA</span>
          </div>
          <span className="text-sm font-bold text-[#0f172a]">Copilot API</span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning && onStop && (
            <button
              onClick={onStop}
              className="px-2.5 py-1 text-[13px] border border-red-200 text-red-500 rounded-md hover:bg-red-50 transition-colors"
            >
              {t('header.stop')}
            </button>
          )}

          {isRunning ? (
            <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-[13px] font-semibold text-green-700">{t('header.running')}</span>
            </div>
          ) : username ? (
            <div className="flex items-center gap-1.5 bg-yellow-50 border border-yellow-200 rounded-full px-2.5 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
              <span className="text-[13px] font-semibold text-yellow-700">{t('header.notStarted')}</span>
            </div>
          ) : null}

          {username && (
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowLogout(v => !v)}
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                  showLogout ? 'bg-blue-600' : 'bg-blue-500 hover:bg-blue-600'
                }`}
              >
                <span className="text-white text-[13px] font-bold">{username[0]?.toUpperCase()}</span>
              </button>
              {showLogout && (
                <div className="absolute right-0 top-full mt-1.5 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-[140px] overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-gray-100">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center shrink-0">
                        <span className="text-white text-[13px] font-bold">{username[0]?.toUpperCase()}</span>
                      </div>
                      <span className="text-[13px] font-semibold text-[#0f172a] truncate max-w-[90px]">{username}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => { setShowLogout(false); onLogout?.() }}
                    className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-red-600 hover:bg-red-50 transition-colors text-left"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                      <polyline points="16 17 21 12 16 7"/>
                      <line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    {t('header.logout')}
                  </button>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-md transition-colors"
            title={t('header.settings')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
