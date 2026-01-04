import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion"

export type MotionPreference = "magic" | "subtle" | "off"

const MOTION_STORAGE_KEY = "motion"

function normalizeMotionPreference(value: string | null): MotionPreference {
  if (value === "magic" || value === "subtle" || value === "off") return value
  return "magic"
}

function readMotionPreference(): MotionPreference {
  if (typeof window === "undefined") return "magic"
  try {
    return normalizeMotionPreference(window.localStorage.getItem(MOTION_STORAGE_KEY))
  } catch {
    return "magic"
  }
}

function writeMotionPreference(value: MotionPreference): void {
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, value)
  } catch {
    // ignore
  }
}

export type MotionPreferenceContextValue = {
  preference: MotionPreference
  effective: MotionPreference
  reducedMotion: boolean
  setPreference: (value: MotionPreference) => void
}

const MotionPreferenceContext = createContext<MotionPreferenceContextValue | null>(null)

export function MotionPreferenceProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()

  const [preference, setPreferenceState] = useState<MotionPreference>(() =>
    readMotionPreference()
  )

  const setPreference = useCallback((value: MotionPreference) => {
    setPreferenceState(value)
  }, [])

  const effective = reducedMotion ? "off" : preference

  useEffect(() => {
    writeMotionPreference(preference)
  }, [preference])

  useEffect(() => {
    document.documentElement.dataset.motion = effective
  }, [effective])

  const value = useMemo<MotionPreferenceContextValue>(() => {
    return { preference, effective, reducedMotion, setPreference }
  }, [effective, preference, reducedMotion, setPreference])

  return (
    <MotionPreferenceContext.Provider value={value}>
      {children}
    </MotionPreferenceContext.Provider>
  )
}

export function useMotionPreference(): MotionPreferenceContextValue {
  const ctx = useContext(MotionPreferenceContext)
  if (!ctx) {
    throw new Error("useMotionPreference must be used within MotionPreferenceProvider")
  }
  return ctx
}
