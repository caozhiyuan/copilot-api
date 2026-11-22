export interface BeforeQuitEventLike {
  preventDefault: () => void
}

export interface BeforeQuitControllerOptions {
  stopServer: () => Promise<void>
  quit: () => void
  onError?: (error: unknown) => void
}

export interface BeforeQuitController {
  handleBeforeQuit: (event: BeforeQuitEventLike) => void
  isQuitting: () => boolean
  markQuitting: () => void
  markServerStopped: () => void
  resetForRetry: () => void
}

export function createBeforeQuitController({
  stopServer,
  quit,
  onError,
}: BeforeQuitControllerOptions): BeforeQuitController {
  let quitting = false
  let serverStoppedForQuit = false
  let pendingShutdown: Promise<void> | null = null

  return {
    handleBeforeQuit(event) {
      if (serverStoppedForQuit) {
        return
      }

      event.preventDefault()
      quitting = true

      if (pendingShutdown) {
        return
      }

      pendingShutdown = (async () => {
        try {
          await stopServer()
        } catch (error) {
          onError?.(error)
        } finally {
          serverStoppedForQuit = true
          pendingShutdown = null
          quit()
        }
      })()
    },
    isQuitting() {
      return quitting
    },
    markQuitting() {
      quitting = true
    },
    markServerStopped() {
      serverStoppedForQuit = true
    },
    resetForRetry() {
      quitting = false
      serverStoppedForQuit = false
    },
  }
}

export interface DestroyableWindow {
  isDestroyed?: () => boolean
}

export function resolveLiveWindow<T extends DestroyableWindow>(
  getWindow: () => T | null | undefined,
): T | null {
  const win = getWindow()
  if (!win || win.isDestroyed?.()) {
    return null
  }
  return win
}
