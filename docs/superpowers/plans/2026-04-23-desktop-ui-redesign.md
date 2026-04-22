# Desktop UI 重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重设计桌面应用三个页面（授权页、看板页、Header），统一简洁商务风视觉，简化用户流程（取消独立 StartPage）。

**Architecture:** 取消 `start` 页面状态，登录后直接进入 `DashboardPage`；`DashboardPage` 内部维护 `started` 状态区分空态（含启动表单）和运行态；Tab 切换 看板/日志；模型列表并入看板。

**Tech Stack:** React + TypeScript + Tailwind CSS + Electron IPC (`window.electronAPI`)

**构建验证命令：** `cd desktop && npm run typecheck`（在 desktop 目录下运行）

---

## 文件变更总览

| 文件 | 操作 |
|------|------|
| `desktop/src/App.tsx` | 修改：移除 `start` 状态，简化流程 |
| `desktop/src/components/Header.tsx` | 修改：新增 `onStop` prop 和停止按钮 |
| `desktop/src/pages/AuthPage.tsx` | 重写：极简全屏，无 Header，展开式 Token 输入 |
| `desktop/src/pages/DashboardPage.tsx` | 重写：合并启动逻辑，Tab 看板/日志，模型并入看板 |
| `desktop/src/pages/StartPage.tsx` | 删除 |

---

## Task 1：简化 App.tsx 页面状态

**Files:**
- Modify: `desktop/src/App.tsx`

- [ ] **Step 1：重写 App.tsx**

将文件内容替换为以下完整实现：

```tsx
import { useState, useEffect } from 'react'
import AuthPage from './pages/AuthPage'
import DashboardPage from './pages/DashboardPage'

export type Page = 'auth' | 'dashboard'

export default function App() {
  const [page, setPage] = useState<Page>('auth')
  const [username, setUsername] = useState<string>('')
  const [port, setPort] = useState<number>(4141)

  useEffect(() => {
    window.electronAPI.checkSavedToken().then((result) => {
      if (result.success && result.username) {
        setUsername(result.username)
        setPage(prev => prev === 'auth' ? 'dashboard' : prev)
      }
    })
  }, [])

  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setPort(settings.lastPort)
    })
  }, [])

  const handleAuthSuccess = (user: string) => {
    setUsername(user)
    setPage('dashboard')
  }

  const handleLogout = async () => {
    await window.electronAPI.logout()
    setUsername('')
    setPage('auth')
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {page === 'auth' && <AuthPage onSuccess={handleAuthSuccess} />}
      {page === 'dashboard' && (
        <DashboardPage
          username={username}
          defaultPort={port}
          onLogout={handleLogout}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2：类型检查**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run typecheck 2>&1 | tail -20
```

预期：只有因 DashboardPage props 变化导致的错误（`port` / `onStop` 相关），其余无误。

- [ ] **Step 3：提交**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1
git add desktop/src/App.tsx
git commit -m "refactor(desktop): simplify page state, remove start page"
```

---

## Task 2：修改 Header.tsx 新增停止按钮

**Files:**
- Modify: `desktop/src/components/Header.tsx`

- [ ] **Step 1：更新 Header.tsx**

```tsx
import { useState } from 'react'
import SettingsModal from './SettingsModal'

interface HeaderProps {
  username?: string
  onLogout?: () => void
  onStop?: () => void
  isRunning?: boolean
}

export default function Header({ username, onLogout, onStop, isRunning }: HeaderProps) {
  const [showSettings, setShowSettings] = useState(false)
  const [showLogout, setShowLogout] = useState(false)

  return (
    <>
      {/* macOS 交通灯按钮占位条，可拖拽移动窗口 */}
      <div
        className="h-9 bg-white shrink-0"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ WebkitAppRegion: 'drag' } as any}
      />
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-white">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-[#0f172a] rounded-md flex items-center justify-center">
            <span className="text-white text-[9px] font-bold">CA</span>
          </div>
          <span className="text-sm font-bold text-[#0f172a]">Copilot API</span>
        </div>

        <div className="flex items-center gap-2">
          {/* 停止按钮：仅运行时显示 */}
          {isRunning && onStop && (
            <button
              onClick={onStop}
              className="px-2.5 py-1 text-xs border border-red-200 text-red-500 rounded-md hover:bg-red-50 transition-colors"
            >
              ■ 停止
            </button>
          )}

          {/* 状态徽章：运行中或未启动 */}
          {isRunning ? (
            <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-[10px] font-semibold text-green-700">运行中</span>
            </div>
          ) : username ? (
            <div className="flex items-center gap-1.5 bg-yellow-50 border border-yellow-200 rounded-full px-2.5 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
              <span className="text-[10px] font-semibold text-yellow-700">未启动</span>
            </div>
          ) : null}

          {/* 用户头像 */}
          {username && (
            <div className="relative">
              <button
                onClick={() => setShowLogout(v => !v)}
                className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center hover:bg-blue-600 transition-colors"
              >
                <span className="text-white text-[9px] font-bold">{username[0]?.toUpperCase()}</span>
              </button>
              {showLogout && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 min-w-24">
                  <button
                    onClick={() => { setShowLogout(false); onLogout?.() }}
                    className="block w-full px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 rounded-xl text-left"
                  >
                    注销
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 设置按钮 */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-md transition-colors"
            title="设置"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
```

- [ ] **Step 2：类型检查**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run typecheck 2>&1 | tail -20
```

预期：Header 相关无错误，可能有 DashboardPage 传参错误（Task 4 会修复）。

- [ ] **Step 3：提交**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1
git add desktop/src/components/Header.tsx
git commit -m "feat(desktop): add stop button and running status to Header"
```

---

## Task 3：重写 AuthPage.tsx

**Files:**
- Modify: `desktop/src/pages/AuthPage.tsx`

- [ ] **Step 1：重写 AuthPage.tsx**

```tsx
import { useState } from 'react'
import type { DeviceCodeInfo } from '../types/ipc'

interface AuthPageProps {
  onSuccess: (username: string) => void
}

type AuthView = 'default' | 'oauth-pending' | 'token-input'

export default function AuthPage({ onSuccess }: AuthPageProps) {
  const [view, setView] = useState<AuthView>('default')
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleOAuth = async () => {
    setLoading(true)
    setError('')
    try {
      const code = await window.electronAPI.getDeviceCode()
      setDeviceCode(code)
      setView('oauth-pending')
      setPolling(true)

      const unsubscribe = window.electronAPI.onAuthSuccess((result) => {
        unsubscribe()
        setPolling(false)
        if (result.success && result.username) {
          onSuccess(result.username)
        } else {
          setError(result.error ?? '授权失败，请重试')
          setView('default')
        }
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDeviceUrl = () => {
    if (deviceCode) window.electronAPI.openUrl(deviceCode.verification_uri)
  }

  const handleCopyCode = () => {
    if (!deviceCode) return
    navigator.clipboard.writeText(deviceCode.user_code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.saveToken(tokenInput.trim())
      if (result.success && result.username) {
        onSuccess(result.username)
      } else {
        setError(result.error ?? 'Token 无效，请重试')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    setView('default')
    setDeviceCode(null)
    setError('')
    setPolling(false)
    setTokenInput('')
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* macOS 交通灯占位条 */}
      <div
        className="h-7 shrink-0"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style={{ WebkitAppRegion: 'drag' } as any}
      />

      <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5">
        {/* Logo + 标题 */}
        <div className="text-center">
          <div className="w-14 h-14 bg-[#0f172a] rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-[0_4px_14px_rgba(0,0,0,0.15)]">
            <span className="text-white text-base font-extrabold">CA</span>
          </div>
          <h1 className="text-lg font-bold text-[#0f172a]">Copilot API</h1>
          <p className="text-xs text-slate-400 mt-1">连接你的 GitHub Copilot</p>
        </div>

        {/* 默认态：两个按钮 */}
        {view === 'default' && (
          <div className="flex flex-col gap-2 w-full max-w-[220px]">
            <button
              onClick={handleOAuth}
              disabled={loading}
              className="w-full py-2.5 bg-[#0f172a] text-white text-xs font-semibold rounded-lg flex items-center justify-center gap-2 hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
              </svg>
              {loading ? '请稍候…' : '使用 GitHub 授权'}
            </button>
            <button
              onClick={() => setView('token-input')}
              className="w-full py-2.5 bg-white border border-slate-200 text-slate-500 text-xs rounded-lg hover:bg-slate-50 transition-colors"
            >
              手动填写 Token
            </button>
          </div>
        )}

        {/* OAuth 等待授权码 */}
        {view === 'oauth-pending' && deviceCode && (
          <div className="w-full max-w-[240px] flex flex-col gap-3">
            <div>
              <p className="text-[10px] text-slate-400 mb-1.5">授权码</p>
              <div className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-slate-300 rounded-lg bg-slate-50">
                <span className="font-mono text-sm font-bold text-[#0f172a] tracking-widest flex-1">
                  {deviceCode.user_code}
                </span>
                <button
                  onClick={handleCopyCode}
                  className="text-[10px] text-blue-500 hover:text-blue-600 shrink-0"
                >
                  {copied ? '✓ 已复制' : '复制'}
                </button>
              </div>
            </div>
            <button
              onClick={handleOpenDeviceUrl}
              className="w-full py-2.5 bg-[#0f172a] text-white text-xs font-semibold rounded-lg hover:bg-slate-800 transition-colors"
            >
              打开授权页面
            </button>
            {polling && (
              <p className="text-center text-xs text-slate-400 animate-pulse">
                等待 GitHub 授权中…
              </p>
            )}
            <button
              onClick={handleBack}
              className="text-[10px] text-slate-400 hover:text-slate-600 text-center"
            >
              ← 返回
            </button>
          </div>
        )}

        {/* Token 输入展开态 */}
        {view === 'token-input' && (
          <div className="w-full max-w-[240px] flex flex-col gap-3">
            <textarea
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="gho_xxxxxxxxxxxxxxxx"
              rows={3}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-xs resize-none focus:outline-none focus:ring-2 focus:ring-slate-300 font-mono"
            />
            <button
              onClick={handleSaveToken}
              disabled={loading || !tokenInput.trim()}
              className="w-full py-2.5 bg-[#0f172a] text-white text-xs font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading ? '验证中…' : '确认添加'}
            </button>
            <button
              onClick={handleBack}
              className="text-[10px] text-slate-400 hover:text-slate-600 text-center"
            >
              ← 返回
            </button>
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="w-full max-w-[240px] px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600 flex items-center gap-1.5">
            <span>⚠️</span><span>{error}</span>
          </div>
        )}

        <p className="text-[10px] text-slate-200">登录即代表授权访问 Copilot API</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2：类型检查**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run typecheck 2>&1 | tail -20
```

预期：AuthPage 无错误。

- [ ] **Step 3：提交**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1
git add desktop/src/pages/AuthPage.tsx
git commit -m "feat(desktop): rewrite AuthPage with minimal full-screen design"
```

---

## Task 4：重写 DashboardPage.tsx

**Files:**
- Modify: `desktop/src/pages/DashboardPage.tsx`

> 关键逻辑说明：
> - `started` state 控制空态/运行态切换
> - Premium 进度条方向改为**已用**（`entitlement - remaining`），数值显示 `已用/总量`
> - Tab：`'dashboard' | 'logs'`

- [ ] **Step 1：重写 DashboardPage.tsx**

```tsx
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

  const premiumUsed = premiumQ && !premiumQ.unlimited
    ? `${Math.floor(premiumQ.entitlement - premiumQ.quota_remaining)} / ${Math.floor(premiumQ.entitlement)}`
    : premiumQ?.unlimited ? '∞' : '—'

  const visibleModels = showAllModels ? models : models.slice(0, 5)

  return (
    <div className="flex flex-col h-screen bg-white">
      <Header
        username={username}
        onLogout={handleLogout}
        onStop={handleStop}
        isRunning={started && !stopping}
      />

      {/* 服务器错误横幅 */}
      {serverError && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600 flex items-center gap-1.5 shrink-0">
          <span>⚠️</span><span>{serverError}</span>
        </div>
      )}

      {/* Tab 栏（仅运行时显示） */}
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
                {/* Premium：显示已用/总量，进度条表示已用 */}
                <QuotaBar
                  label="Premium"
                  quota={premiumQ}
                  loading={loading}
                  mode="used"
                />
                <QuotaBar label="Chat" quota={chatQ} loading={loading} mode="remaining" />
                <QuotaBar label="Completions" quota={completionsQ} loading={loading} mode="remaining" />
              </div>
            </div>

            {/* 可用模型 */}
            {models.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-xl p-3">
                <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">可用模型</h3>
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
              </div>
            )}
          </div>
        )}

        {/* ── 日志 Tab ── */}
        {started && tab === 'logs' && (
          <div className="p-4 h-full flex flex-col">
            <div className="flex-1 bg-[#0f172a] rounded-xl p-4 flex flex-col overflow-hidden">
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
```

- [ ] **Step 2：类型检查**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run typecheck 2>&1 | tail -20
```

预期：0 errors。

- [ ] **Step 3：提交**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1
git add desktop/src/pages/DashboardPage.tsx
git commit -m "feat(desktop): rewrite DashboardPage with merged start/tab design"
```

---

## Task 5：删除 StartPage.tsx

**Files:**
- Delete: `desktop/src/pages/StartPage.tsx`

- [ ] **Step 1：删除文件**

```bash
rm /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop/src/pages/StartPage.tsx
```

- [ ] **Step 2：全局检查是否还有 StartPage 引用**

```bash
grep -r "StartPage" /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop/src/
```

预期：无任何输出（已无引用）。

- [ ] **Step 3：类型检查**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run typecheck 2>&1 | tail -20
```

预期：0 errors。

- [ ] **Step 4：提交**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1
git add -A desktop/src/pages/StartPage.tsx
git commit -m "refactor(desktop): remove StartPage, logic merged into DashboardPage"
```

---

## Task 6：构建验证

- [ ] **Step 1：完整构建**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run build 2>&1 | tail -30
```

预期：构建成功，无错误。

- [ ] **Step 2：启动开发模式目测验证**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1/desktop && npm run dev
```

逐一验证：
1. 授权页：极简全屏，Logo + 两个按钮
2. 点击「使用 GitHub 授权」→ 展示设备码等待态，有「← 返回」
3. 点击「手动填写 Token」→ 展开 textarea，有「← 返回」
4. 授权成功后 → 跳 Dashboard，Header 显示「未启动」黄色徽章
5. 端口输入 + 启动 → Header 变绿「运行中」+ 停止按钮出现
6. Tab 切换 看板/日志 正常
7. 看板页 Premium 显示「已用/总量」格式
8. 停止服务 → 回到空态，停止按钮消失

- [ ] **Step 3：最终提交（如有遗留修改）**

```bash
cd /Users/fangzuchang/Documents/Projects/IdeaProjects/copilot-api1
git add -A desktop/src/
git commit -m "feat(desktop): complete UI redesign - clean business style"
```
