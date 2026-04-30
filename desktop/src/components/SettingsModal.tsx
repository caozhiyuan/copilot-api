import { useState, useEffect } from 'react'
import type { DesktopSettings } from '../types/ipc'
import { useLanguage } from '../contexts/LanguageContext'
import { translate, type LangPreference } from '../locales'

interface SettingsModalProps {
  onClose: () => void
}

type Section = 'general' | 'startup'

function requiresAppRestart(previous: DesktopSettings, next: DesktopSettings): boolean {
  return previous.apiHome !== next.apiHome
    || previous.oauthApp !== next.oauthApp
    || previous.enterpriseUrl !== next.enterpriseUrl
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none ${checked ? 'bg-[#0f172a]' : 'bg-slate-200'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3.5 border-b border-slate-100 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[#0f172a]">{label}</div>
        {description && <div className="text-[12px] text-slate-400 mt-0.5 leading-relaxed">{description}</div>}
      </div>
      {children}
    </div>
  )
}

const IconGeneral = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>
  </svg>
)

const IconStartup = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
)

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { t, setLangPref } = useLanguage()
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<DesktopSettings>({
    apiHome: '',
    oauthApp: 'default',
    enterpriseUrl: '',
    lastPort: 4141,
    minimizeToTray: false,
    accountType: 'individual',
    verbose: false,
    showToken: false,
    language: 'auto',
  })
  const [initialSettings, setInitialSettings] = useState<DesktopSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getSettings().then((loadedSettings) => {
      setSettings(loadedSettings)
      setInitialSettings(loadedSettings)
    })
  }, [])

  const handleSave = async () => {
    const shouldPromptRestart = initialSettings !== null && requiresAppRestart(initialSettings, settings)

    setSaving(true)
    try {
      await window.electronAPI.saveSettings(settings)
      setLangPref(settings.language)

      if (shouldPromptRestart) {
        window.alert(translate('settings.restartAppPrompt', settings.language, undefined, navigator.language))
      }

      onClose()
    } finally {
      setSaving(false)
    }
  }

  const langOptions: { value: LangPreference; label: string }[] = [
    { value: 'auto', label: t('settings.langAuto') },
    { value: 'en',   label: t('settings.langEn') },
    { value: 'zh',   label: t('settings.langZh') },
  ]

  const navItems: { key: Section; label: string; icon: React.ReactNode }[] = [
    { key: 'general',  label: t('settings.sectionGeneral'),  icon: <IconGeneral /> },
    { key: 'startup',  label: t('settings.sectionStartup'),  icon: <IconStartup /> },
  ]

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-[540px] h-[480px] flex flex-col overflow-hidden">

        {/* Title bar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-slate-100 rounded-lg flex items-center justify-center text-slate-500">
              <IconGeneral />
            </div>
            <span className="text-[14px] font-semibold text-[#0f172a]">{t('settings.title')}</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Main content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Left navigation */}
          <div className="w-[152px] shrink-0 bg-slate-50 border-r border-slate-100 py-3 px-2 flex flex-col gap-0.5">
            {navItems.map(item => (
              <button
                key={item.key}
                onClick={() => setSection(item.key)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[13px] transition-colors text-left ${
                  section === item.key
                    ? 'bg-white shadow-sm font-semibold text-[#0f172a]'
                    : 'font-medium text-slate-500 hover:text-[#0f172a] hover:bg-slate-100/70'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>

          {/* Right panel */}
          <div className="flex-1 overflow-y-auto px-6 py-5">

            {section === 'general' && (
              <div>
                <div className="mb-1">
                  <div className="text-[13px] font-semibold text-[#0f172a] mb-2">{t('settings.sectionLanguage')}</div>
                  <select
                    value={settings.language}
                    onChange={e => setSettings(s => ({ ...s, language: e.target.value as LangPreference }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[13px] text-[#0f172a] bg-white focus:outline-none focus:ring-2 focus:ring-slate-300 cursor-pointer"
                  >
                    {langOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <SettingRow label={t('settings.minimizeToTray')} description={t('settings.minimizeToTrayDesc')}>
                  <Toggle
                    checked={settings.minimizeToTray}
                    onChange={v => setSettings(s => ({ ...s, minimizeToTray: v }))}
                  />
                </SettingRow>
              </div>
            )}

            {section === 'startup' && (
              <div>
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800">
                  {t('settings.restartAppNote')}
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-[#0f172a] mb-1.5">{t('settings.oauthApp')}</div>
                  <select
                    value={settings.oauthApp}
                    onChange={e => setSettings(s => ({ ...s, oauthApp: e.target.value as DesktopSettings['oauthApp'] }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[13px] text-[#0f172a] bg-white focus:outline-none focus:ring-2 focus:ring-slate-300 cursor-pointer"
                  >
                    <option value="default">{t('settings.oauthAppDefault')}</option>
                    <option value="opencode">opencode</option>
                  </select>
                  <p className="text-[12px] text-slate-400 mt-1.5 leading-relaxed">{t('settings.oauthAppDesc')}</p>
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-[#0f172a] mb-1.5">{t('settings.apiHome')}</div>
                  <input
                    type="text"
                    placeholder="C:/copilot-api"
                    value={settings.apiHome}
                    onChange={e => setSettings(s => ({ ...s, apiHome: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-slate-50 text-[#0f172a] placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-300 focus:bg-white transition-colors"
                  />
                  <p className="text-[12px] text-slate-400 mt-1.5 leading-relaxed">{t('settings.apiHomeDesc')}</p>
                </div>
                <div className="mb-4">
                  <div className="text-[13px] font-medium text-[#0f172a] mb-1.5">{t('settings.enterpriseUrl')}</div>
                  <input
                    type="text"
                    placeholder="company.ghe.com"
                    value={settings.enterpriseUrl}
                    onChange={e => setSettings(s => ({ ...s, enterpriseUrl: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[13px] bg-slate-50 text-[#0f172a] placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-300 focus:bg-white transition-colors"
                  />
                  <p className="text-[12px] text-slate-400 mt-1.5 leading-relaxed">{t('settings.enterpriseUrlDesc')}</p>
                </div>
                <SettingRow label={t('settings.verbose')} description={t('settings.verboseDesc')}>
                  <Toggle
                    checked={settings.verbose}
                    onChange={v => setSettings(s => ({ ...s, verbose: v }))}
                  />
                </SettingRow>
                <SettingRow label={t('settings.showToken')} description={t('settings.showTokenDesc')}>
                  <Toggle
                    checked={settings.showToken}
                    onChange={v => setSettings(s => ({ ...s, showToken: v }))}
                  />
                </SettingRow>
              </div>
            )}

          </div>
        </div>

        {/* Footer actions */}
        <div className="flex gap-2 justify-end px-5 py-3.5 border-t border-slate-100 bg-slate-50/60 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
          >
            {t('settings.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-[13px] bg-[#0f172a] text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>

      </div>
    </div>
  )
}
