import { useState, useEffect } from 'react'
import type { DesktopSettings } from '../types/ipc'

interface SettingsModalProps {
  onClose: () => void
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<DesktopSettings>({
    proxy: { http: '', https: '' },
    lastPort: 4141
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    await window.electronAPI.saveSettings(settings)
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-[480px] p-6">
        <h2 className="text-[13px] font-semibold mb-4">代理设置</h2>
        <p className="text-[13px] text-gray-500 mb-4">
          配置后，授权和服务的所有网络请求将通过代理发送
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[13px] font-medium text-gray-700 mb-1">
              HTTP 代理
            </label>
            <input
              type="text"
              placeholder="http://127.0.0.1:7890"
              value={settings.proxy.http}
              onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, http: e.target.value } }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-gray-700 mb-1">
              HTTPS 代理
            </label>
            <input
              type="text"
              placeholder="http://127.0.0.1:7890"
              value={settings.proxy.https}
              onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, https: e.target.value } }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-6 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-[13px] bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
