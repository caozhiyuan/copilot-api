import { createContext, useContext, useEffect } from "react"

export type MotionPreference = "magic" | "subtle" | "off"

export type MotionPreferenceContextValue = {
  preference: MotionPreference
  effective: MotionPreference
  reducedMotion: boolean
  setPreference: (value: MotionPreference) => void
}

const MotionPreferenceContext = createContext<MotionPreferenceContextValue | null>(null)

// Motion is intentionally fixed to "magic" for all users, including those
// with prefers-reduced-motion enabled. See PR #39 for rationale.
const FIXED_MOTION: MotionPreference = "magic"

const FIXED_VALUE: MotionPreferenceContextValue = {
  preference: FIXED_MOTION,
  effective: FIXED_MOTION,
  reducedMotion: false,
  setPreference: () => {
    // no-op: motion is fixed to "magic"
  },
}

export function MotionPreferenceProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    document.documentElement.dataset.motion = FIXED_MOTION
  }, [])

  return (
    <MotionPreferenceContext.Provider value={FIXED_VALUE}>
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
