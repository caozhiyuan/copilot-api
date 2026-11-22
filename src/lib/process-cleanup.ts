type CleanupHandler = () => void | Promise<void>

const cleanupHandlers = new Set<CleanupHandler>()

let drainServer: CleanupHandler | undefined
let cleanupPromise: Promise<void> | null = null
let cleanupState: "idle" | "running" | "done" = "idle"
let runtimeInitialized = false

function initializeProcessCleanupRuntime(): void {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  process.once("beforeExit", () => {
    void runProcessCleanups()
  })
  process.once("exit", runProcessCleanupsSync)
  process.once("SIGINT", () => {
    void shutdownProcess(0)
  })
  process.once("SIGTERM", () => {
    void shutdownProcess(0)
  })
}

function runProcessCleanupsSync(): void {
  if (cleanupState !== "idle") {
    return
  }

  cleanupState = "done"
  for (const handler of Array.from(cleanupHandlers)) {
    try {
      void handler()
    } catch {
      // Ignore best-effort cleanup failures during process exit.
    }
  }
}

async function runProcessCleanups(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise
  }

  if (cleanupState === "done") {
    return
  }

  cleanupState = "running"
  cleanupPromise = (async () => {
    try {
      if (drainServer) await drainServer()
    } finally {
      for (const handler of Array.from(cleanupHandlers)) {
        await handler()
      }
      cleanupState = "done"
    }
  })()

  return cleanupPromise
}

async function shutdownProcess(exitCode: number): Promise<void> {
  try {
    await runProcessCleanups()
  } finally {
    process.exit(exitCode)
  }
}

export function registerProcessShutdownDrain(handler: CleanupHandler): void {
  drainServer = handler
  initializeProcessCleanupRuntime()
}

export function registerProcessCleanup(handler: CleanupHandler): () => void {
  initializeProcessCleanupRuntime()
  cleanupHandlers.add(handler)

  return () => {
    cleanupHandlers.delete(handler)
  }
}
