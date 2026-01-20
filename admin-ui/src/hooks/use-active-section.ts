import { useCallback, useEffect, useRef, useState } from "react"

export type SettingsSection = {
  id: string
  label: string
}

type UseActiveSectionOptions = {
  sectionIds: Array<string>
  rootMargin?: string
  threshold?: number
}

type UseActiveSectionReturn = {
  activeSection: string
  registerSection: (id: string, element: HTMLElement | null) => void
  scrollToSection: (id: string) => void
}

/**
 * Hook to track which section is currently visible in the viewport.
 * Uses IntersectionObserver for efficient scroll detection.
 */
export function useActiveSection({
  sectionIds,
  rootMargin = "-20% 0px -60% 0px",
  threshold = 0.5,
}: UseActiveSectionOptions): UseActiveSectionReturn {
  const [activeSection, setActiveSection] = useState(sectionIds[0] ?? "")
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<IntersectionObserver | null>(null)

  const registerSection = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      sectionRefs.current.set(id, element)
      // Observe immediately if observer exists
      observerRef.current?.observe(element)
    } else {
      const existingElement = sectionRefs.current.get(id)
      if (existingElement) {
        observerRef.current?.unobserve(existingElement)
      }
      sectionRefs.current.delete(id)
    }
  }, [])

  const scrollToSection = useCallback((id: string) => {
    const element = sectionRefs.current.get(id)
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // Find visible entries and sort by position
        const visibleEntries = entries.filter((entry) => entry.isIntersecting)

        if (visibleEntries.length > 0) {
          // Sort by top position, take the one closest to top
          visibleEntries.sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          )
          const topEntry = visibleEntries[0]
          const id = (topEntry.target as HTMLElement).dataset.sectionId
          if (id) {
            setActiveSection(id)
          }
        }
      },
      { rootMargin, threshold }
    )

    observerRef.current = observer

    // Observe all currently registered sections
    for (const element of sectionRefs.current.values()) {
      observer.observe(element)
    }

    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [rootMargin, threshold])

  return { activeSection, registerSection, scrollToSection }
}
