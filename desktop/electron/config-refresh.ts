interface ConfigRefreshDependencies {
  isRunning: () => boolean
  readAdminApiKey: () => Promise<string>
  invalidateConfigCache: () => void
  reloadConfig: (adminApiKeys: string[]) => Promise<void>
}

export interface SaveAndRefreshOptions {
  // The value is already persisted once the refresh runs, so a failed refresh
  // is not a failed save. Callers that still have follow-up work to finish
  // (persisting the account type, leaving the sign-in page) report the stale
  // server through onRefreshError instead of rejecting.
  ignoreRefreshFailure?: boolean
  onRefreshError?: (error: Error) => void
  onRefreshSuccess?: () => void
}

export function createConfigRefresher(dependencies: ConfigRefreshDependencies) {
  let pendingUpdate: Promise<unknown> = Promise.resolve()
  let activeAdminApiKey: string | undefined

  const saveAndRefresh = <Result>(
    save: () => Result | Promise<Result>,
    options: SaveAndRefreshOptions = {},
  ): Promise<Result> => {
    const update = pendingUpdate.then(async () => {
      const running = dependencies.isRunning()
      const adminApiKey = running ? await dependencies.readAdminApiKey() : ''
      if (!running) activeAdminApiKey = undefined
      if (running) activeAdminApiKey ||= adminApiKey
      const result = await save()
      dependencies.invalidateConfigCache()
      if (running && dependencies.isRunning()) {
        const savedAdminApiKey = await dependencies.readAdminApiKey()
        const adminApiKeys = [
          ...new Set([
            activeAdminApiKey ?? adminApiKey,
            adminApiKey,
            savedAdminApiKey,
          ]),
        ].filter(Boolean)
        try {
          await dependencies.reloadConfig(adminApiKeys)
        } catch (error) {
          if (!options.ignoreRefreshFailure) {
            throw error
          }
          // Keep the previously active key so the next save can still
          // authenticate against the config the server has in memory.
          options.onRefreshError?.(error as Error)
          return result
        }
        activeAdminApiKey = await dependencies.readAdminApiKey()
        options.onRefreshSuccess?.()
      }
      return result
    })
    pendingUpdate = update.catch(() => {})
    return update
  }

  return {
    saveAndRefresh,
    setActiveAdminApiKey: (adminApiKey: string | undefined) => {
      activeAdminApiKey = adminApiKey
    },
  }
}
