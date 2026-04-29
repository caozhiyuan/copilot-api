import { useState, useEffect } from 'react'
import type { DesktopSettings } from '../types/ipc'
import { useLanguage } from '../contexts/LanguageContext'
import type { LangPreference } from '../locales'

interface SettingsModalProps {
  onClose: () => void
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`}
      />
    </button>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2 mt-5 first:mt-0">
      {children}
    </h3>
  )
}

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="mr-4">
        <div className="text-[13px] font-medium text-gray-800">{label}</div>
        {description && <div className="text-[12px] text-gray-500 mt-0.5">{description}</div>}
      </div>
      {children}
    </div>
  )
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { t, setLangPref } = useLanguage()
  const [settings, setSettings] = useState<DesktopSettings>({
    proxy: { http: '', https: '' },
    lastPort: 4141,
    minimizeToTray: false,
    accountType: 'individual',
    verbose: false,
    showToken: false,
    language: 'auto',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    await window.electronAPI.saveSettings(settings)
    setLangPref(settings.language)
    setSaving(false)
    onClose()
  }

  const langOptions: { value: LangPreference; label: string }[] = [
    { value: 'auto', label: t('settings.langAuto') },
    { value: 'en',   label: t('settings.langEn') },
    { value: 'zh',   label: t('settings.langZh') },
  ]

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-[480px] p-6 max-h-[85vh] flex flex-col">
        <h2 className="text-[14px] font-semibold mb-1">{t('settings.title')}</h2>
        <p className="text-[12px] text-gray-500 mb-4">{t('settings.restartNote')}</p>

        <div className="flex-1 overflow-y-auto pr-1 -mr-1">
          {/* 常规 */}
          <SectionTitle>{t('settings.sectionGeneral')}</SectionTitle>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 px-3">
            <Row label={t('settings.minimizeToTray')} description={t('settings.minimizeToTrayDesc')}>
              <Toggle
                checked={settings.minimizeToTray}
                onChange={v => setSettings(s => ({ ...s, minimizeToTray: v }))}
              />
            </Row>
          </div>

          {/* 代理 */}
          <SectionTitle>{t('settings.sectionProxy')}</SectionTitle>
          <div className="space-y-2">
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1">{t('settings.httpProxy')}</label>
              <input
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={settings.proxy.http}
                onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, http: e.target.value } }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1">{t('settings.httpsProxy')}</label>
              <input
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={settings.proxy.https}
                onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, https: e.target.value } }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* 启动参数 */}
          <SectionTitle>{t('settings.sectionStartup')}</SectionTitle>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 px-3">
            <Row label={t('settings.verbose')} description={t('settings.verboseDesc')}>
              <Toggle
                checked={settings.verbose}
                onChange={v => setSettings(s => ({ ...s, verbose: v }))}
              />
            </Row>
            <Row label={t('settings.showToken')} description={t('settings.showTokenDesc')}>
              <Toggle
                checked={settings.showToken}
                onChange={v => setSettings(s => ({ ...s, showToken: v }))}
              />
            </Row>
          </div>

          {/* 语言 */}
          <SectionTitle>{t('settings.sectionLanguage')}</SectionTitle>
          <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 px-3">
            {langOptions.map(opt => (
              <label key={opt.value} className="flex items-center justify-between py-2.5 cursor-pointer">
                <span className="text-[13px] font-medium text-gray-800">{opt.label}</span>
                <input
                  type="radio"
                  name="language"
                  value={opt.value}
                  checked={settings.language === opt.value}
                  onChange={() => setSettings(s => ({ ...s, language: opt.value }))}
                  className="accent-blue-600"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mt-5 justify-end pt-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {t('settings.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-[13px] bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
