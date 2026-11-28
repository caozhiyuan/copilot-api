import { useEffect, useState, type ReactNode } from 'react'
import { createDefaultSettings } from '../../shared/default-settings'
import { useLanguage } from '../contexts/LanguageContext'
import { useTheme } from '../contexts/ThemeContext'
import { isValidServerHost } from '../lib/server-url'
import { translate } from '../locales'
import type {
  BunRuntimeStatus,
  DesktopSettings,
  ServerKeysConfig,
  ServerKeysConfigUpdate,
  ThemePreference,
} from '../types/ipc'
import AppUpdatePanel from './AppUpdatePanel'
import { GeneralSettingsSection } from './settings/GeneralSettingsSection'
import { NetworkSettingsSection } from './settings/NetworkSettingsSection'
import { SecuritySettingsSection } from './settings/SecuritySettingsSection'
import {
  IconGeneral,
  IconMonitor,
  IconNetwork,
  IconSecurity,
  IconStartup,
} from './settings/SettingsPrimitives'
import { StartupSettingsSection } from './settings/StartupSettingsSection'

interface SettingsModalProps {
  onClose: () => void
  initialSection?: Section
  checkForUpdatesOnOpen?: boolean
}

type Section = 'general' | 'security' | 'network' | 'startup' | 'updates'

function requiresAppRestart(
  previous: DesktopSettings,
  next: DesktopSettings,
): boolean {
  return (
    previous.apiHome !== next.apiHome
    || previous.sqliteDbPath !== next.sqliteDbPath
    || previous.oauthApp !== next.oauthApp
    || previous.enterpriseUrl !== next.enterpriseUrl
  )
}

export default function SettingsModal({
  onClose,
  initialSection = 'general',
  checkForUpdatesOnOpen = false,
}: SettingsModalProps) {
  const { t, setLangPref } = useLanguage()
  const { setThemePref } = useTheme()
  const [section, setSection] = useState<Section>(initialSection)
  const [settings, setSettings] = useState<DesktopSettings>(
    createDefaultSettings,
  )
  const [initialSettings, setInitialSettings] =
    useState<DesktopSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [bunRuntime, setBunRuntime] = useState<BunRuntimeStatus | null>(null)
  const [adminApiKey, setAdminApiKey] = useState('')
  const [loadedServerKeys, setLoadedServerKeys] =
    useState<ServerKeysConfig | null>(null)

  useEffect(() => {
    let active = true
    void window.electronAPI
      .getBunRuntime()
      .then((runtime) => {
        if (active) setBunRuntime(runtime)
      })
      .catch(() => {
        if (active) setBunRuntime({ available: false })
      })
    void Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getServerKeys(),
    ])
      .then(([loadedSettings, serverKeys]) => {
        if (!active) return
        setSettings(loadedSettings)
        setInitialSettings(loadedSettings)
        setAdminApiKey(serverKeys.adminApiKey)
        setLoadedServerKeys(serverKeys)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const handleSave = async () => {
    const shouldPromptRestart =
      initialSettings !== null && requiresAppRestart(initialSettings, settings)

    setSaving(true)
    try {
      // Only persist the fields the user actually changed. Sending the whole
      // snapshot captured when the modal opened could clobber external updates
      // (server startup regenerating a cleared admin key, CLI auth keys), so
      // the main process merges only the provided fields into the latest
      // config on disk.
      const nextAdminApiKey = adminApiKey.trim()
      const serverKeysUpdate: ServerKeysConfigUpdate = {}
      const saveErrors: string[] = []
      if (
        loadedServerKeys !== null
        && nextAdminApiKey !== loadedServerKeys.adminApiKey
      ) {
        serverKeysUpdate.adminApiKey = nextAdminApiKey
      }

      if (
        loadedServerKeys !== null
        && Object.keys(serverKeysUpdate).length > 0
      ) {
        try {
          const savedKeys =
            await window.electronAPI.saveServerKeys(serverKeysUpdate)
          setAdminApiKey(savedKeys.adminApiKey)
          setLoadedServerKeys(savedKeys)
        } catch (error) {
          saveErrors.push(
            `${t('settings.serverKeysSaveFailed')}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      try {
        await window.electronAPI.saveSettings(settings)
      } catch (error) {
        saveErrors.push(
          `${t('settings.desktopSettingsSaveFailed')}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (saveErrors.length > 0) {
        throw new Error(saveErrors.join('\n'))
      }
      setLangPref(settings.language)
      setThemePref(settings.theme)

      if (shouldPromptRestart) {
        window.alert(
          translate(
            'settings.restartAppPrompt',
            settings.language,
            undefined,
            navigator.language,
          ),
        )
      }

      onClose()
    } catch (error) {
      const [savedSettings, savedServerKeys] = await Promise.all([
        window.electronAPI.getSettings().catch(() => initialSettings),
        window.electronAPI.getServerKeys().catch(() => null),
      ])
      if (savedSettings) {
        setSettings(savedSettings)
        setLangPref(savedSettings.language)
        setThemePref(savedSettings.theme)
      }
      if (savedServerKeys) {
        setAdminApiKey(savedServerKeys.adminApiKey)
        setLoadedServerKeys(savedServerKeys)
      }
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const navItems: { key: Section; label: string; icon: ReactNode }[] = [
    {
      key: 'general',
      label: t('settings.sectionGeneral'),
      icon: <IconGeneral />,
    },
    {
      key: 'security',
      label: t('settings.sectionSecurity'),
      icon: <IconSecurity />,
    },
    {
      key: 'network',
      label: t('settings.sectionNetwork'),
      icon: <IconNetwork />,
    },
    {
      key: 'startup',
      label: t('settings.sectionStartup'),
      icon: <IconStartup />,
    },
    {
      key: 'updates',
      label: t('updates.title'),
      icon: <IconMonitor />,
    },
  ]

  const handleThemeChange = (value: ThemePreference) => {
    setSettings((s) => ({ ...s, theme: value }))
    setThemePref(value)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/70">
      <div className="flex h-[500px] max-h-[calc(100vh-40px)] w-[592px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-line bg-elevated shadow-xl dark:shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
        {/* Title bar */}
        <div className="flex shrink-0 items-center justify-between border-b border-line-soft bg-surface px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sunken text-ink-soft dark:bg-blue-500/15 dark:text-blue-300 dark:ring-1 dark:ring-blue-400/20">
              <IconGeneral />
            </div>
            <span className="text-[14px] font-semibold text-ink">
              {t('settings.title')}
            </span>
          </div>
          <button
            onClick={onClose}
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

        {/* Main content */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left navigation */}
          <div className="flex w-[158px] shrink-0 flex-col gap-0.5 border-r border-line-soft bg-sunken px-2 py-3">
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
                  section === item.key ?
                    'bg-surface font-semibold text-ink shadow-sm ring-1 ring-line-soft'
                  : 'font-medium text-ink-soft hover:bg-surface/70 hover:text-ink'
                }`}
              >
                <span
                  className={
                    section === item.key ?
                      'text-accent dark:text-blue-300'
                    : 'text-ink-faint'
                  }
                >
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>

          {/* Right panel */}
          <div className="flex-1 overflow-y-auto bg-elevated px-6 py-5">
            {section === 'updates' && (
              <AppUpdatePanel checkOnMount={checkForUpdatesOnOpen} />
            )}
            {section === 'general' && (
              <GeneralSettingsSection
                onThemeChange={handleThemeChange}
                setSettings={setSettings}
                settings={settings}
              />
            )}
            {section === 'security' && (
              <SecuritySettingsSection
                adminApiKey={adminApiKey}
                onAdminApiKeyChange={setAdminApiKey}
              />
            )}
            {section === 'network' && (
              <NetworkSettingsSection
                setSettings={setSettings}
                settings={settings}
              />
            )}
            {section === 'startup' && (
              <StartupSettingsSection
                bunRuntime={bunRuntime}
                setSettings={setSettings}
                settings={settings}
              />
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-line-soft bg-sunken/70 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
          >
            {t('settings.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !isValidServerHost(settings.host)}
            className="rounded-lg bg-brand px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
