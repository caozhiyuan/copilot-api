import type { Dispatch, SetStateAction } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { BunRuntimeStatus, DesktopSettings } from '../../types/ipc'
import {
  inputClass,
  selectClass,
  SettingRow,
  Toggle,
} from './SettingsPrimitives'

interface StartupSettingsSectionProps {
  bunRuntime: BunRuntimeStatus | null
  setSettings: Dispatch<SetStateAction<DesktopSettings>>
  settings: DesktopSettings
}

export function StartupSettingsSection({
  bunRuntime,
  setSettings,
  settings,
}: StartupSettingsSectionProps) {
  const { t } = useLanguage()

  return (
    <div>
      <div className="mb-4">
        <label
          htmlFor="server-runtime"
          className="text-[13px] font-medium text-ink mb-1.5 block"
        >
          {t('settings.serverRuntime')}
        </label>
        <select
          id="server-runtime"
          value={settings.serverRuntime}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              serverRuntime: e.target.value as DesktopSettings['serverRuntime'],
            }))
          }
          className={selectClass}
        >
          <option value="bun">{t('settings.runtimeBun')}</option>
          <option value="node">{t('settings.runtimeNode')}</option>
        </select>
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.serverRuntimeDesc')}
        </p>
        <p
          role="status"
          title={bunRuntime?.path}
          className="text-[12px] text-ink-faint mt-1.5 leading-relaxed"
        >
          {bunRuntime === null ?
            t('settings.bunDetecting')
          : bunRuntime.available ?
            t('settings.bunAvailable', {
              version: bunRuntime.version ?? '',
            })
          : bunRuntime.version ?
            t('settings.bunUnsupported', {
              version: bunRuntime.version,
            })
          : t('settings.bunUnavailable')}
        </p>
        {settings.serverRuntime === 'bun' && (
          <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
            {t('settings.bunProxyNote')}
          </p>
        )}
      </div>
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-400">
        {t('settings.restartAppNote')}
      </div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.oauthApp')}
        </div>
        <select
          value={settings.oauthApp}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              oauthApp: e.target.value as DesktopSettings['oauthApp'],
            }))
          }
          className={selectClass}
        >
          <option value="default">{t('settings.oauthAppDefault')}</option>
          <option value="opencode">opencode</option>
        </select>
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.oauthAppDesc')}
        </p>
      </div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.apiHome')}
        </div>
        <input
          type="text"
          placeholder="C:/copilot-api"
          value={settings.apiHome}
          onChange={(e) =>
            setSettings((s) => ({ ...s, apiHome: e.target.value }))
          }
          className={inputClass}
        />
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.apiHomeDesc')}
        </p>
      </div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.sqliteDbPath')}
        </div>
        <input
          type="text"
          placeholder="C:/copilot-api/copilot-api.sqlite"
          value={settings.sqliteDbPath}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              sqliteDbPath: e.target.value,
            }))
          }
          className={inputClass}
        />
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.sqliteDbPathDesc')}
        </p>
      </div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.enterpriseUrl')}
        </div>
        <input
          type="text"
          placeholder="company.ghe.com"
          value={settings.enterpriseUrl}
          onChange={(e) =>
            setSettings((s) => ({
              ...s,
              enterpriseUrl: e.target.value,
            }))
          }
          className={inputClass}
        />
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.enterpriseUrlDesc')}
        </p>
      </div>
      <SettingRow
        label={t('settings.verbose')}
        description={t('settings.verboseDesc')}
      >
        <Toggle
          checked={settings.verbose}
          onChange={(v) => setSettings((s) => ({ ...s, verbose: v }))}
        />
      </SettingRow>
      <SettingRow
        label={t('settings.showToken')}
        description={t('settings.showTokenDesc')}
      >
        <Toggle
          checked={settings.showToken}
          onChange={(v) => setSettings((s) => ({ ...s, showToken: v }))}
        />
      </SettingRow>
    </div>
  )
}
