import type { Dispatch, SetStateAction } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import { isValidServerHost } from '../../lib/server-url'
import type { DesktopProxyMode, DesktopSettings } from '../../types/ipc'
import {
  inputClass,
  segmentedButtonClass,
  segmentedGroupClass,
} from './SettingsPrimitives'

interface NetworkSettingsSectionProps {
  setSettings: Dispatch<SetStateAction<DesktopSettings>>
  settings: DesktopSettings
}

export function NetworkSettingsSection({
  setSettings,
  settings,
}: NetworkSettingsSectionProps) {
  const { t } = useLanguage()

  const proxyModeOptions: { value: DesktopProxyMode; label: string }[] = [
    { value: 'system', label: t('settings.proxyModeSystem') },
    { value: 'custom', label: t('settings.proxyModeCustom') },
    { value: 'direct', label: t('settings.proxyModeDirect') },
  ]
  const isCustomProxy = settings.proxy.mode === 'custom'

  return (
    <div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.host')}
        </div>
        <input
          type="text"
          placeholder="127.0.0.1"
          value={settings.host}
          onChange={(e) => setSettings((s) => ({ ...s, host: e.target.value }))}
          className={inputClass}
        />
        {isValidServerHost(settings.host) ?
          <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
            {t('settings.hostDesc')}
          </p>
        : <p className="text-[12px] mt-1.5 leading-relaxed text-red-600 dark:text-red-400">
            {t('settings.hostInvalid')}
          </p>
        }
      </div>
      <div className="mb-4 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-soft dark:border-blue-400/15 dark:bg-blue-500/10 dark:text-blue-100/80">
        {t('settings.proxySystemNote')}
      </div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.proxyMode')}
        </div>
        <div className={segmentedGroupClass}>
          {proxyModeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={settings.proxy.mode === opt.value}
              onClick={() =>
                setSettings((s) => ({
                  ...s,
                  proxy: { ...s.proxy, mode: opt.value },
                }))
              }
              className={segmentedButtonClass(
                settings.proxy.mode === opt.value,
                'whitespace-nowrap',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.httpProxy')}
        </div>
        <input
          type="text"
          disabled={!isCustomProxy}
          value={settings.proxy.http_proxy}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              proxy: { ...s.proxy, http_proxy: e.target.value },
            }))
          }
          className={inputClass}
        />
      </div>
      <div className="mt-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.httpsProxy')}
        </div>
        <input
          type="text"
          disabled={!isCustomProxy}
          value={settings.proxy.https_proxy}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              proxy: { ...s.proxy, https_proxy: e.target.value },
            }))
          }
          className={inputClass}
        />
      </div>
      <div className="mt-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.noProxy')}
        </div>
        <input
          type="text"
          disabled={!isCustomProxy}
          value={settings.proxy.no_proxy}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              proxy: { ...s.proxy, no_proxy: e.target.value },
            }))
          }
          className={inputClass}
        />
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.noProxyDesc')}
        </p>
      </div>
    </div>
  )
}
