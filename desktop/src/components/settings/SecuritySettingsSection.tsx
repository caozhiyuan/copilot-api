import { useLanguage } from '../../contexts/LanguageContext'
import { inputClass } from './SettingsPrimitives'

interface SecuritySettingsSectionProps {
  adminApiKey: string
  onAdminApiKeyChange: (value: string) => void
}

export function SecuritySettingsSection({
  adminApiKey,
  onAdminApiKeyChange,
}: SecuritySettingsSectionProps) {
  const { t } = useLanguage()

  return (
    <div>
      <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] leading-relaxed text-blue-800 dark:border-blue-400/15 dark:bg-blue-500/10 dark:text-blue-100/80">
        {t('settings.serverKeysNote')}
      </div>
      <div className="mb-4">
        <div className="text-[13px] font-medium text-ink mb-1.5">
          {t('settings.adminKeyLabel')}
        </div>
        <input
          type="text"
          value={adminApiKey}
          onChange={(e) => onAdminApiKeyChange(e.target.value)}
          className={inputClass}
          placeholder={t('settings.adminKeyPlaceholder')}
        />
        <p className="text-[12px] text-ink-faint mt-1.5 leading-relaxed">
          {t('settings.adminKeyDesc')}
        </p>
      </div>
    </div>
  )
}
