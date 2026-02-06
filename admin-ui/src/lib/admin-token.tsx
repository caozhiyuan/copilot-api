import React, { createContext, useContext, useMemo, useState } from "react"

const ADMIN_TOKEN_STORAGE_KEY = "adminToken"

export function readAdminToken(): string {
  if (typeof window === "undefined") return ""

  try {
    const local = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || ""
    if (local) return local

    // One-time migration from legacy sessionStorage.
    const legacy = window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || ""
    if (legacy) {
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, legacy)
      window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY)
      return legacy
    }
  } catch {
    // Ignore Web Storage access errors (e.g. disabled storage).
  }

  return ""
}

export function writeAdminToken(token: string): void {
  if (typeof window === "undefined") return

  try {
    const trimmed = token.trim()
    if (trimmed) {
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmed)
    } else {
      window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY)
    }

    // Cleanup legacy storage.
    window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY)
  } catch {
    // Ignore Web Storage access errors (e.g. disabled storage).
  }
}

type AdminTokenContextValue = {
  token: string
  setToken: (token: string) => void
  clearToken: () => void
}

const AdminTokenContext = createContext<AdminTokenContextValue | null>(null)

export function AdminTokenProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [token, setTokenState] = useState<string>(() => readAdminToken())

  const value = useMemo<AdminTokenContextValue>(() => {
    return {
      token,
      setToken: (next) => {
        writeAdminToken(next)
        setTokenState(readAdminToken())
      },
      clearToken: () => {
        writeAdminToken("")
        setTokenState("")
      },
    }
  }, [token])

  return <AdminTokenContext.Provider value={value}>{children}</AdminTokenContext.Provider>
}

export function useAdminToken(): AdminTokenContextValue {
  const ctx = useContext(AdminTokenContext)
  if (!ctx) {
    throw new Error("useAdminToken must be used within <AdminTokenProvider />")
  }
  return ctx
}
