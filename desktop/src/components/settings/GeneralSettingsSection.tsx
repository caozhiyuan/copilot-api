import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { LangPreference } from '../../locales'
import type { DesktopSettings, ThemePreference } from '../../types/ipc'
import {
  IconMonitor,
  IconMoon,
  IconSun,
  segmentedButtonClass,
  segmentedGroupClass,
  selectClass,
  SettingRow,
  Toggle,
} from './SettingsPrimitives'

interface GeneralSettingsSectionProps {
  onThemeChange: (value: ThemePreference) => void
  setSettings: Dispatch<SetStateAction<DesktopSettings>>
  settings: DesktopSettings
}

export function GeneralSettingsSection({
  onThemeChange,
  setSettings,
  settings,
}: GeneralSettingsSectionProps) {
  const { t } = useLanguage()

  const langOptions: { value: LangPreference; label: string }[] = [
    { value: 'auto', label: t('settings.langAuto') },
    { value: 'en', label: t('settings.langEn') },
    { value: 'zh', label: t('settings.langZh') },
  ]

  const themeOptions: {
    value: ThemePreference
    label: string
    icon: ReactNode
  }[] = [
    { value: 'light', label: t('settings.themeLight'), icon: <IconSun /> },
    { value: 'dark', label: t('settings.themeDark'), icon: <IconMoon /> },
    { value: 'auto', label: t('settings.themeAuto'), icon: <IconMonitor /> },
  ]

  const supportsLaunchAtLogin =
    window.electronAPI.platform === 'win32'
    || window.electronAPI.platform === 'darwin'
    || window.electronAPI.platform === 'linux'

  return (
    <div>
      <div className="mb-1">
        <div className="text-[13px] font-semibold text-ink mb-2">
          {t('settings.sectionLanguage')}
        </div>
        <select
          value={settings.language}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              language: e.target.value as LangPreference,
            }))
          }
          className={selectClass}
        >
          {langOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-1 mt-4">
        <div className="text-[13px] font-semibold text-ink mb-2">
          {t('settings.sectionTheme')}
        </div>
        <div className={segmentedGroupClass}>
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={settings.theme === opt.value}
              onClick={() => onThemeChange(opt.value)}
              className={segmentedButtonClass(
                settings.theme === opt.value,
                'flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap',
              )}
            >
              <span className="shrink-0">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {supportsLaunchAtLogin && (
        <SettingRow
          label={t('settings.launchAtLogin')}
          description={t('settings.launchAtLoginDesc')}
        >
          <Toggle
            checked={settings.launchAtLogin}
            onChange={(v) => setSettings((s) => ({ ...s, launchAtLogin: v }))}
          />
        </SettingRow>
      )}

      <SettingRow
        label={t('settings.autoStartServer')}
        description={t('settings.autoStartServerDesc')}
      >
        <Toggle
          checked={settings.autoStartServer}
          onChange={(v) => setSettings((s) => ({ ...s, autoStartServer: v }))}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.minimizeToTray')}
        description={t('settings.minimizeToTrayDesc')}
      >
        <Toggle
          checked={settings.minimizeToTray}
          onChange={(v) => setSettings((s) => ({ ...s, minimizeToTray: v }))}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.showCreate')}
        description={t('settings.showCreateDesc')}
      >
        <Toggle
          checked={settings.showCreate}
          onChange={(v) => setSettings((s) => ({ ...s, showCreate: v }))}
        />
      </SettingRow>
    </div>
  )
}
