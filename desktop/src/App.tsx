import { useState, useEffect } from 'react'
import AuthPage from './pages/AuthPage'
import DashboardPage from './pages/DashboardPage'
import { useLanguage } from './contexts/LanguageContext'

export type Page = 'auth' | 'dashboard'

export default function App() {
  const [page, setPage] = useState<Page | null>(null)
  const [username, setUsername] = useState<string>('')
  const [port, setPort] = useState<number>(4141)
  const { setLangPref } = useLanguage()

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      try {
        const [authResult, settings] = await Promise.all([
          window.electronAPI.checkSavedToken(),
          window.electronAPI.getSettings(),
        ])

        if (!active) return

        setPort(settings.lastPort)
        setLangPref(settings.language ?? 'auto')

        if (authResult.success && authResult.username) {
          setUsername(authResult.username)
          setPage('dashboard')
          return
        }

        setPage('auth')
      } catch {
        if (active) setPage('auth')
      }
    }

    void bootstrap()

    return () => {
      active = false
    }
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
      {page === null && <div className="min-h-screen bg-white" />}
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
