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
