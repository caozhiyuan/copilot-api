import { useState, useEffect, useRef } from 'react'
import Header from '../components/Header'

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

export default function DashboardPage({ username, defaultPort, onLogout }: DashboardPageProps) {
  const [started, setStarted] = useState(false)
  const [port, setPort] = useState<string>(String(defaultPort))
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [stopping, setStopping] = useState(false)

  const [tab, setTab] = useState<'dashboard' | 'logs'>('dashboard')
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(false)
  const [serverError, setServerError] = useState('')
  const [copied, setCopied] = useState<string>('')

  const [logs, setLogs] = useState<string[]>([])
  const [showAllModels, setShowAllModels] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const portNum = parseInt(port, 10)
  const openaiUrl = `http://localhost:${portNum}/v1`
  const anthropicUrl = `http://localhost:${portNum}`

  // 监听服务异常停止
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerStatus((status) => {
      if (!status.running) {
        setServerError(status.error ?? '服务已意外停止')
        setStarted(false)
      }
    })
    return unsubscribe
  }, [])

  // 订阅实时日志
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerLog((log) => {
      setLogs(prev => [...prev, log])
    })
    return unsubscribe
  }, [])

  // 日志自动滚动
  useEffect(() => {
    if (tab === 'logs') logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, tab])

  // 服务启动后拉取数据
  useEffect(() => {
    if (started) fetchData()
  }, [started])

  const handleStart = async () => {
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setStartError('请输入有效的端口号（1–65535）')
      return
    }
    setStarting(true)
    setStartError('')
    setServerError('')
    try {
      const status = await window.electronAPI.startServer(portNum)
      if (status.running) {
        setStarted(true)
      } else {
        setStartError(status.error ?? '服务启动失败')
      }
    } catch (err) {
      setStartError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    setStopping(true)
    await window.electronAPI.stopServer()
    setStopping(false)
    setStarted(false)
    setUsage(null)
    setModels([])
    setServerError('')
  }

  const handleLogout = async () => {
    if (started) await window.electronAPI.stopServer()
    onLogout()
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      // 通过 IPC 由主进程代理 HTTP 请求，绕过渲染进程 file:// origin 的 CORS 限制
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
      // 服务可能仍在初始化
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

  const premiumUsed = premiumQ
    ? premiumQ.unlimited
      ? '∞'
      : `${Math.floor(premiumQ.entitlement - premiumQ.quota_remaining)} / ${Math.floor(premiumQ.entitlement)}`
    : '—'

  const visibleModels = showAllModels ? models : models.slice(0, 5)

  return (
    <div className="flex flex-col h-screen bg-white">
      <Header
        username={username}
        onLogout={handleLogout}
        onStop={handleStop}
        isRunning={started && !stopping}
      />

      {/* 服务异常停止横幅 */}
      {serverError && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600 flex items-center gap-1.5 shrink-0">
          <span>⚠️</span><span>{serverError}</span>
        </div>
      )}

      {/* Tab 栏（仅服务运行时显示） */}
      {started && (
        <div className="flex px-4 bg-white border-b border-slate-100 shrink-0">
          {(['dashboard', 'logs'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs border-b-2 transition-colors ${
                tab === t
                  ? 'font-semibold text-[#0f172a] border-[#0f172a]'
                  : 'text-slate-400 border-transparent hover:text-slate-600'
              }`}
            >
              {t === 'dashboard' ? '看板' : '日志'}
            </button>
          ))}
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-auto">

        {/* ── 空态：启动表单 ── */}
        {!started && (
          <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
            <div className="w-11 h-11 bg-slate-100 rounded-xl flex items-center justify-center text-xl">🚀</div>
            <div className="text-center">
              <p className="text-sm font-semibold text-[#0f172a]">服务未运行</p>
              <p className="text-xs text-slate-400 mt-1">配置端口后一键启动</p>
            </div>
            <div className="w-full max-w-[190px] bg-slate-50 border border-slate-200 rounded-xl p-3.5 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">端口</span>
                <input
                  type="number"
                  value={port}
                  onChange={e => { setPort(e.target.value); setStartError('') }}
                  min={1}
                  max={65535}
                  className="flex-1 bg-white border border-slate-200 rounded-md py-1 px-2 text-sm font-semibold text-[#0f172a] text-center focus:outline-none focus:ring-2 focus:ring-slate-300"
                />
              </div>
              {startError && (
                <p className={`text-[10px] px-2 py-1.5 rounded-md ${
                  startError.includes('占用')
                    ? 'bg-orange-50 text-orange-700 border border-orange-200'
                    : 'bg-red-50 text-red-600 border border-red-200'
                }`}>
                  {startError.includes('占用') ? '🔌' : '⚠️'} {startError}
                </p>
              )}
              <button
                onClick={handleStart}
                disabled={starting}
                className="w-full py-2 bg-[#0f172a] text-white text-xs font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {starting ? '启动中…' : '▶ 启动服务'}
              </button>
            </div>
          </div>
        )}

        {/* ── 看板 Tab ── */}
        {started && tab === 'dashboard' && (
          <div className="p-4 flex flex-col gap-3">
            {/* 指标卡片 */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-white border border-slate-200 rounded-xl p-3">
                <div className={`text-base font-bold text-[#0f172a] ${loading ? 'animate-pulse text-slate-200' : ''}`}>
                  {loading ? '…' : (usage?.copilot_plan ?? '—')}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">Copilot Plan</div>
              </div>
              <div className="bg-green-50 border border-green-200 rounded-xl p-3">
                <div className={`text-base font-bold text-green-600 ${loading ? 'animate-pulse' : ''}`}>
                  {loading ? '…' : premiumUsed}
                </div>
                <div className="text-[10px] text-green-400 mt-0.5">Premium 已用</div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-3">
                <div className={`text-xs font-bold text-[#0f172a] ${loading ? 'animate-pulse text-slate-200' : ''}`}>
                  {loading ? '…' : (usage?.quota_reset_date ?? '—')}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">配额重置</div>
              </div>
            </div>

            {/* 服务地址 */}
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">服务地址</h3>
              <div className="space-y-1.5">
                {[
                  { label: 'OpenAI', url: openaiUrl, key: 'openai', color: 'bg-slate-500' },
                  { label: 'Anthropic', url: anthropicUrl, key: 'anthropic', color: 'bg-violet-600' },
                ].map(({ label, url, key, color }) => (
                  <div key={key} className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 rounded-lg">
                    <span className={`text-[9px] font-semibold text-white ${color} rounded px-1.5 py-0.5 shrink-0`}>{label}</span>
                    <span className="text-[10px] font-mono text-slate-600 truncate flex-1">{url}</span>
                    <button
                      onClick={() => handleCopy(url, key)}
                      className="shrink-0 text-[10px] text-blue-500 hover:text-blue-600"
                    >
                      {copied === key ? '✓' : '复制'}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 配额使用 */}
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">配额使用</h3>
                <button
                  onClick={fetchData}
                  disabled={loading}
                  className="text-[10px] text-blue-500 hover:text-blue-600 disabled:opacity-50"
                >
                  {loading ? '刷新中…' : '🔄 刷新'}
                </button>
              </div>
              <div className="space-y-2.5">
                <QuotaBar label="Premium" quota={premiumQ} loading={loading} mode="used" />
                <QuotaBar label="Chat" quota={chatQ} loading={loading} mode="remaining" />
                <QuotaBar label="Completions" quota={completionsQ} loading={loading} mode="remaining" />
              </div>
            </div>

            {/* 可用模型 */}
            {(loading || models.length > 0) && (
              <div className="bg-white border border-slate-200 rounded-xl p-3">
                <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">可用模型</h3>
                {loading ? (
                  <p className="text-xs text-slate-400 animate-pulse">加载中…</p>
                ) : (
                  <div className="space-y-1">
                    {visibleModels.map(m => (
                      <div key={m.id} className="px-2.5 py-1 bg-slate-50 rounded-md text-[10px] text-slate-600 truncate" title={m.id}>
                        {m.id}
                      </div>
                    ))}
                    {models.length > 5 && (
                      <button
                        onClick={() => setShowAllModels(v => !v)}
                        className="text-[10px] text-blue-500 hover:text-blue-600 px-2.5 py-1"
                      >
                        {showAllModels ? '收起' : `+${models.length - 5} 个模型…`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 日志 Tab ── */}
        {started && tab === 'logs' && (
          <div className="p-4 h-full flex flex-col">
            <div className="flex-1 bg-[#0f172a] rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
              <div className="flex items-center justify-between mb-3 shrink-0">
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">服务日志</span>
                <button
                  onClick={() => setLogs([])}
                  className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  清空
                </button>
              </div>
              <div className="flex-1 overflow-y-auto font-mono text-xs text-green-400 space-y-0.5 leading-relaxed">
                {logs.length === 0 ? (
                  <span className="text-slate-600">暂无日志…</span>
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

// ── 子组件 ──

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
        <span className="text-[10px] text-slate-500">{label}</span>
        <span className={`text-[10px] font-medium ${loading ? 'text-slate-200' : 'text-slate-600'}`}>
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
