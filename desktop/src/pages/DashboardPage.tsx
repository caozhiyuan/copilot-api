import { useState, useEffect, useRef } from 'react'

import Header from '../components/Header'
import { useLanguage } from '../contexts/LanguageContext'
import type { ServerAuthInfo } from '../types/ipc'

interface DashboardPageProps {
  username: string
  defaultPort: number
  onLogout: () => void
}

interface QuotaDetail {
  entitlement: number
  quota_remaining: number
  unlimited: boolean
}

interface UsageInfo {
  copilot_plan?: string
  quota_reset_date?: string
  quota_snapshots?: {
    chat?: QuotaDetail
    completions?: QuotaDetail
    premium_interactions?: QuotaDetail
  }
  [key: string]: unknown
}

interface Model {
  id: string
  [key: string]: unknown
}

function calcUsedPct(q: QuotaDetail): number {
  if (q.unlimited || q.entitlement === 0) return 0
  const used = q.entitlement - q.quota_remaining
  return Math.min(100, Math.round((used / q.entitlement) * 100))
}

function calcRemainingPct(q: QuotaDetail): number {
  if (q.unlimited || q.entitlement === 0) return 100
  return Math.min(100, Math.round((q.quota_remaining / q.entitlement) * 100))
}

function getQuotaBarColor(pct: number, isUsed: boolean): string {
  if (isUsed) {
    if (pct >= 80) return 'bg-red-500'
    if (pct >= 50) return 'bg-orange-400'
    return 'bg-[#0f172a]'
  }
  if (pct >= 50) return 'bg-blue-500'
  if (pct >= 20) return 'bg-orange-400'
  return 'bg-red-500'
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(Math.max(value.length, 4))
  return `${value.slice(0, 4)}********${value.slice(-4)}`
}

export default function DashboardPage({ username, defaultPort, onLogout }: DashboardPageProps) {
  const { t } = useLanguage()
  const [started, setStarted] = useState(false)
  const [port, setPort] = useState<string>(String(defaultPort))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [stopping, setStopping] = useState(false)

  const [tab, setTab] = useState<'dashboard' | 'logs'>('dashboard')
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [serverAuthInfo, setServerAuthInfo] = useState<ServerAuthInfo>({ enabled: false })
  const [loading, setLoading] = useState(false)
  const [serverError, setServerError] = useState('')
  const [copied, setCopied] = useState<string>('')

  const [logs, setLogs] = useState<string[]>([])
  const logEndRef = useRef<HTMLDivElement>(null)
  const intentionalStop = useRef(false)

  const portNum = parseInt(port, 10)
  const openaiUrl = `http://localhost:${portNum}/v1`
  const anthropicUrl = `http://localhost:${portNum}`

  // Watch server status changes and only surface unexpected stops.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerStatus((status) => {
      if (!status.running) {
        if (!intentionalStop.current) {
          setServerError(status.error ?? t('dashboard.serverUnexpectedStop'))
          setStarted(false)
          void window.electronAPI.getLogs().then(setLogs).catch(() => {})
        }
        intentionalStop.current = false
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    void window.electronAPI.getLogs().then(setLogs).catch(() => {})
  }, [])

  // Subscribe to live logs.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerLog((log) => {
      setLogs(prev => [...prev, log])
    })
    return unsubscribe
  }, [])

  // Auto-scroll the log view.
  useEffect(() => {
    if (tab === 'logs' || (!started && (startError || serverError))) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, tab, started, startError, serverError])

  // Fetch data after the server starts.
  useEffect(() => {
    if (started) fetchData()
  }, [started])

  useEffect(() => {
    if (!started) {
      setServerAuthInfo({ enabled: false })
      return
    }

    window.electronAPI.getServerAuthInfo().then(setServerAuthInfo).catch(() => {
      setServerAuthInfo({ enabled: false })
    })
  }, [started])

  const handleStart = async () => {
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setStartError(t('dashboard.invalidPort'))
      return
    }
    setStarting(true)
    setStartError('')
    setServerError('')
    setLogs([])
    try {
      const status = await window.electronAPI.startServer(portNum)
      if (status.running) {
        setStarted(true)
      } else {
        setStartError(status.error ?? t('dashboard.serverUnexpectedStop'))
        void window.electronAPI.getLogs().then(setLogs).catch(() => {})
      }
    } catch (err) {
      setStartError((err as Error).message)
      void window.electronAPI.getLogs().then(setLogs).catch(() => {})
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    intentionalStop.current = true
    setStopping(true)
    await window.electronAPI.stopServer()
    setStopping(false)
    setStarted(false)
    setUsage(null)
    setModels([])
    setServerError('')
  }

  const handleLogout = async () => {
    intentionalStop.current = true
    if (started) await window.electronAPI.stopServer()
    onLogout()
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      // Proxy HTTP requests through IPC so the main process bypasses renderer CORS.
      const [usageData, modelsData] = await Promise.all([
        window.electronAPI.fetchUsage(),
        window.electronAPI.fetchModels()
      ])
      if (usageData) setUsage(usageData as UsageInfo)
      if (modelsData) {
        const d = modelsData as { data: Model[] }
        setModels(d.data ?? [])
      }
    } catch {
      // The server may still be initializing.
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 1500)
    })
  }

  const premiumQ = usage?.quota_snapshots?.premium_interactions
  const chatQ = usage?.quota_snapshots?.chat
  const completionsQ = usage?.quota_snapshots?.completions
  const shouldShowFailureLogs = !started && Boolean(startError || serverError)
  const serverAuthHeaderName = serverAuthInfo.headerName ?? ''
  const serverAuthHeaderValue = serverAuthInfo.headerValue ?? ''
  const serverAuthHeader = serverAuthHeaderName && serverAuthHeaderValue
    ? `${serverAuthHeaderName}: ${serverAuthHeaderValue}`
    : ''
  const maskedServerAuthHeader = serverAuthHeaderName && serverAuthHeaderValue
    ? `${serverAuthHeaderName}: ${maskSecret(serverAuthHeaderValue)}`
    : ''

  const premiumUsed = premiumQ
    ? premiumQ.unlimited
      ? '∞'
      : `${Math.floor(premiumQ.entitlement - premiumQ.quota_remaining)} / ${Math.floor(premiumQ.entitlement)}`
    : '—'

  return (
    <div className="flex flex-col h-screen bg-white">
      <Header
        username={username}
        onLogout={handleLogout}
        onStop={handleStop}
        isRunning={started && !stopping}
      />

      {/* Unexpected server stop banner */}
      {serverError && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[13px] text-red-600 flex items-center gap-1.5 shrink-0">
          <span>⚠️</span><span>{serverError}</span>
        </div>
      )}

      {/* Tabs shown only while the server is running */}
      {started && (
        <div className="flex px-4 bg-white border-b border-slate-100 shrink-0">
          {(['dashboard', 'logs'] as const).map(tabKey => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-3 py-2 text-[13px] border-b-2 transition-colors ${
                tab === tabKey
                  ? 'font-semibold text-[#0f172a] border-[#0f172a]'
                  : 'text-slate-400 border-transparent hover:text-slate-600'
              }`}
            >
              {tabKey === 'dashboard' ? t('dashboard.tabDashboard') : t('dashboard.tabLogs')}
            </button>
          ))}
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-auto">

        {/* Empty state: start form */}
        {!started && (
          <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
            <div className="w-11 h-11 bg-slate-100 rounded-xl flex items-center justify-center text-[13px]">🚀</div>
            <div className="text-center">
              <p className="text-[13px] font-semibold text-[#0f172a]">{t('dashboard.serverStopped')}</p>
              <p className="text-[13px] text-slate-400 mt-1">{t('dashboard.configPort')}</p>
            </div>
            <div className="w-full max-w-[190px] bg-slate-50 border border-slate-200 rounded-xl p-3.5 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-slate-500">{t('dashboard.port')}</span>
                <input
                  type="number"
                  value={port}
                  onChange={e => { setPort(e.target.value); setStartError('') }}
                  min={1}
                  max={65535}
                  className="flex-1 bg-white border border-slate-200 rounded-md py-1 px-2 text-[13px] font-semibold text-[#0f172a] text-center focus:outline-none focus:ring-2 focus:ring-slate-300"
                />
              </div>
              {startError && (
                <p className="text-[13px] px-2 py-1.5 rounded-md bg-red-50 text-red-600 border border-red-200">
                  ⚠️ {startError}
                </p>
              )}
              <button
                onClick={handleStart}
                disabled={starting}
                className="w-full py-2 bg-[#0f172a] text-white text-[13px] font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {starting ? t('dashboard.starting') : t('dashboard.startServer')}
              </button>
            </div>
            {shouldShowFailureLogs && (
              <div className="w-full max-w-2xl bg-[#0f172a] rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
                <div className="flex items-center justify-between mb-3 shrink-0">
                  <span className="text-[13px] font-semibold text-slate-400 uppercase tracking-wide">{t('dashboard.serverLog')}</span>
                </div>
                <div className="max-h-60 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed">
                  {logs.length === 0 ? (
                    <span className="text-slate-600">{t('dashboard.noLogs')}</span>
                  ) : (
                    logs.map((line, i) => (
                      <div key={i} className="whitespace-pre-wrap break-all">{line.trimEnd()}</div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Dashboard tab */}
        {started && tab === 'dashboard' && (
          <div className="p-4">
            <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-w-0 flex-col gap-3">
                {/* Metric cards */}
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <div className="bg-white border border-slate-200 rounded-xl p-3">
                    <div className={`text-[13px] font-bold text-[#0f172a] ${loading ? 'animate-pulse text-slate-200' : ''}`}>
                      {loading ? '…' : (usage?.copilot_plan ?? '—')}
                    </div>
                    <div className="text-[13px] text-slate-400 mt-0.5">Copilot Plan</div>
                  </div>
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                    <div className={`text-[13px] font-bold text-green-600 ${loading ? 'animate-pulse' : ''}`}>
                      {loading ? '…' : premiumUsed}
                    </div>
                    <div className="text-[13px] text-green-400 mt-0.5">{t('dashboard.premiumUsed')}</div>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-xl p-3">
                    <div className={`text-[13px] font-bold text-[#0f172a] ${loading ? 'animate-pulse text-slate-200' : ''}`}>
                      {loading ? '…' : (usage?.quota_reset_date ?? '—')}
                    </div>
                    <div className="text-[13px] text-slate-400 mt-0.5">{t('dashboard.quotaReset')}</div>
                  </div>
                </div>

                {/* Service endpoints */}
                <div className="bg-white border border-slate-200 rounded-xl p-3">
                  <h3 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wide mb-2">{t('dashboard.serviceAddress')}</h3>
                  <div className="space-y-1.5">
                    {[
                      { label: 'OpenAI', url: openaiUrl, key: 'openai', color: 'bg-slate-500' },
                      { label: 'Anthropic', url: anthropicUrl, key: 'anthropic', color: 'bg-violet-600' },
                    ].map(({ label, url, key, color }) => (
                      <div key={key} className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 rounded-lg">
                        <span className={`text-[13px] font-semibold text-white ${color} rounded px-1.5 py-0.5 shrink-0`}>{label}</span>
                        <span className="text-[13px] font-mono text-slate-600 truncate flex-1">{url}</span>
                        <button
                          onClick={() => handleCopy(url, key)}
                          className="shrink-0 text-[13px] text-blue-500 hover:text-blue-600"
                        >
                          {copied === key ? '✓' : t('dashboard.copy')}
                        </button>
                      </div>
                    ))}
                  </div>
                  {serverAuthInfo.enabled && serverAuthInfo.headerName && serverAuthInfo.headerValue && (
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <h4 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                        {t('dashboard.authHeader')}
                      </h4>
                      <div className="flex items-start gap-2 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                        <span className="text-[13px] font-mono text-amber-900 break-all flex-1">
                          {maskedServerAuthHeader}
                        </span>
                        <button
                          onClick={() => handleCopy(serverAuthHeader, 'auth-header')}
                          className="shrink-0 text-[13px] text-blue-500 hover:text-blue-600"
                        >
                          {copied === 'auth-header' ? '✓' : t('dashboard.copy')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Quota usage */}
                <div className="bg-white border border-slate-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wide">{t('dashboard.quotaUsage')}</h3>
                    <button
                      onClick={fetchData}
                      disabled={loading}
                      className="text-[13px] text-blue-500 hover:text-blue-600 disabled:opacity-50"
                    >
                      {loading ? t('dashboard.refreshing') : t('dashboard.refresh')}
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    <QuotaBar label="Premium" quota={premiumQ} loading={loading} mode="used" />
                    <QuotaBar label="Chat" quota={chatQ} loading={loading} mode="remaining" />
                    <QuotaBar label="Completions" quota={completionsQ} loading={loading} mode="remaining" />
                  </div>
                </div>
              </div>

              {/* Available models */}
              <div className="min-w-0">
                <div className="bg-white border border-slate-200 rounded-xl p-3 xl:max-h-[calc(100vh-190px)] xl:min-h-[420px] flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
                    <h3 className="text-[13px] font-semibold text-slate-400 uppercase tracking-wide">{t('dashboard.availableModels')}</h3>
                    {!loading && <span className="text-[13px] text-slate-400 shrink-0">{t('dashboard.modelsCount', { n: models.length })}</span>}
                  </div>
                  {loading ? (
                    <p className="text-[13px] text-slate-400 animate-pulse">{t('dashboard.loading')}</p>
                  ) : models.length > 0 ? (
                    <div className="flex-1 space-y-1 overflow-y-auto pr-1 min-h-0">
                      {models.map(m => (
                        <div key={m.id} className="px-2.5 py-1 bg-slate-50 rounded-md text-[13px] text-slate-600 truncate" title={m.id}>
                          {m.id}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[13px] text-slate-400">{t('dashboard.noModels')}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Logs tab */}
        {started && tab === 'logs' && (
          <div className="p-4 h-full flex flex-col">
            <div className="flex-1 bg-[#0f172a] rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[13px] font-semibold text-slate-400 uppercase tracking-wide">{t('dashboard.serverLog')}</span>
                <button
                  onClick={() => setLogs([])}
                  className="text-[13px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {t('dashboard.clear')}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed">
                {logs.length === 0 ? (
                  <span className="text-slate-600">{t('dashboard.noLogs')}</span>
                ) : (
                  logs.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">{line.trimEnd()}</div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

// Subcomponents

function QuotaBar({ label, quota, loading, mode }: {
  label: string
  quota: QuotaDetail | undefined
  loading: boolean
  mode: 'used' | 'remaining'
}) {
  const pct = quota ? (mode === 'used' ? calcUsedPct(quota) : calcRemainingPct(quota)) : 0
  const colorClass = getQuotaBarColor(pct, mode === 'used')

  let displayText = '—'
  if (quota) {
    if (quota.unlimited) {
      displayText = '∞'
    } else if (mode === 'used') {
      const used = Math.floor(quota.entitlement - quota.quota_remaining)
      displayText = `${used} / ${Math.floor(quota.entitlement)}`
    } else {
      displayText = `${Math.floor(quota.quota_remaining)} / ${Math.floor(quota.entitlement)}`
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[13px] text-slate-500">{label}</span>
        <span className={`text-[13px] font-medium ${loading ? 'text-slate-200' : 'text-slate-600'}`}>
          {loading ? '…' : displayText}
        </span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        {loading
          ? <div className="h-full bg-slate-200 animate-pulse rounded-full" />
          : quota && <div className={`h-full rounded-full transition-all ${colorClass}`} style={{ width: `${pct}%` }} />
        }
      </div>
    </div>
  )
}
