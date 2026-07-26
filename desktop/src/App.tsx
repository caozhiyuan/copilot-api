import { useState, useEffect } from 'react'
import AuthPage from './pages/AuthPage'
import DashboardPage from './pages/DashboardPage'
import { useLanguage } from './contexts/LanguageContext'
import { autoStartServer } from './lib/auto-start-server'
import type { AuthResult, DesktopAuthMode, ServerStatus } from './types/ipc'

export type Page = 'auth' | 'dashboard'

function BootScreen({ loadingText }: { loadingText: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-strong text-base font-extrabold text-white shadow-[0_10px_30px_rgba(30,41,59,0.20)] dark:bg-[#4f94f8]">
          CA
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-bold text-ink">Copilot API</h1>
          <p className="text-[13px] text-ink-faint">{loadingText}</p>
        </div>
        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page | null>(null)
  const [authMode, setAuthMode] = useState<DesktopAuthMode>('none')
  const [canReturnFromAuth, setCanReturnFromAuth] = useState(false)
  const [port, setPort] = useState<number>(4141)
  const [initialServerStatus, setInitialServerStatus] = useState<ServerStatus>()
  const { setLangPref, t } = useLanguage()

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        const [authResult, settings] = await Promise.all([
          window.electronAPI.getAuthStatus(),
          window.electronAPI.getSettings(),
        ])

        if (!active) return

        setPort(settings.lastPort)
        setLangPref(settings.language ?? 'auto')

        if (authResult.success && authResult.mode !== 'none') {
          const serverStatus = await autoStartServer(
            settings,
            authResult,
            window.electronAPI.startServer,
          )
          if (!active) return

          setAuthMode(authResult.mode)
          setInitialServerStatus(serverStatus)
          setCanReturnFromAuth(false)
          setPage('dashboard')
          return
        }

        setCanReturnFromAuth(false)
        setPage('auth')
      } catch {
        if (active) {
          setCanReturnFromAuth(false)
          setPage('auth')
        }
      }
    }

    void bootstrap()

    return () => {
      active = false
    }
  }, [])

  const handleAuthSuccess = (result: AuthResult) => {
    setAuthMode(result.mode ?? 'provider')
    setInitialServerStatus(undefined)
    setCanReturnFromAuth(false)
    setPage('dashboard')
  }

  const handleChangeAuth = () => {
    setInitialServerStatus(undefined)
    setCanReturnFromAuth(true)
    setPage('auth')
  }

  const handleBackToDashboard = () => {
    setCanReturnFromAuth(false)
    setPage('dashboard')
  }

  if (page === null) {
    return <BootScreen loadingText={t('auth.loading')} />
  }

  if (page === 'auth') {
    return (
      <AuthPage
        onBack={canReturnFromAuth ? handleBackToDashboard : undefined}
        onSuccess={handleAuthSuccess}
      />
    )
  }

  return (
    <DashboardPage
      authMode={authMode}
      defaultPort={port}
      initialServerStatus={initialServerStatus}
      onChangeAuth={handleChangeAuth}
    />
  )
}
