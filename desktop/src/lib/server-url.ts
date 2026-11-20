// Renderer-side host helpers. The web bundle cannot import
// src/lib/server-host because that module depends on node:net, so this
// module reuses the dependency-free primitives in
// src/lib/server-host-shared. Parity with the server is locked by
// tests/server-host-parity.test.ts. Wildcard handling differs on purpose:
// the server maps wildcards to the dialable 127.0.0.1, while the dashboard
// displays the friendlier localhost.
import {
  isWildcardHostname,
  normalizeHostnameBase,
} from '../../../src/lib/http/server-host-shared'

export function resolveDisplayHost(host: string | null | undefined): string {
  const normalizedHost = host?.trim()
  if (!normalizedHost || isWildcardHostname(normalizedHost)) {
    return 'localhost'
  }
  return normalizedHost
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function buildServerBaseUrl(
  host: string | null | undefined,
  port: number,
): string {
  return `http://${formatHostForUrl(resolveDisplayHost(host))}:${port}`
}

// Rejects the same hosts normalizeServerHostname would throw on, so the
// dashboard can flag unsupported hosts before the server process rejects
// them. Blank stays valid and means "use the default host".
export function isValidServerHost(host: string | null | undefined): boolean {
  const normalizedHost = host?.trim() ?? ''
  if (!normalizedHost) {
    return true
  }
  try {
    normalizeHostnameBase(normalizedHost)
    return true
  } catch {
    return false
  }
}

export function resolveEffectiveServerHost(
  host: string | undefined,
  settingsHost: string | null | undefined,
): string {
  if (host === undefined) return settingsHost?.trim() ?? ''
  return host.trim()
}
