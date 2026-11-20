const VERSION_URL = "https://x.ai/cli/stable"
const VERSION_CACHE_MS = 24 * 60 * 60 * 1000
const VERSION_RETRY_MS = 5 * 60 * 1000

// Verified against the official stable channel on 2026-10-06; used offline only.
let cachedVersion = "1.0.46"
let nextVersionCheck = 0
let versionInFlight: Promise<string> | undefined

async function refreshGrokBuildVersion(): Promise<string> {
  nextVersionCheck = Date.now() + VERSION_RETRY_MS
  try {
    // This is the channel pointer used by https://x.ai/cli/install.ps1.
    const response = await fetch(VERSION_URL, {
      signal: AbortSignal.timeout(3000),
    })
    if (response.ok) {
      const version = (await response.text()).trim()
      if (/^\d+\.\d+\.\d+$/u.test(version)) {
        cachedVersion = version
        nextVersionCheck = Date.now() + VERSION_CACHE_MS
      }
    }
  } catch {
    // A version lookup failure must not prevent inference.
  }
  return cachedVersion
}

export async function getGrokBuildVersion(): Promise<string> {
  if (versionInFlight) return await versionInFlight
  if (Date.now() < nextVersionCheck) return cachedVersion
  versionInFlight = refreshGrokBuildVersion().finally(() => {
    versionInFlight = undefined
  })
  return await versionInFlight
}
