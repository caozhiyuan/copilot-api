// Pure hostname helpers shared by the gateway server (Node) and the desktop
// app (including the renderer bundle). This module must stay free of
// `node:*` imports because the renderer cannot use `node:net`; all
// address-family checks live in `server-host.ts`.
export const INVALID_HOST_CHARACTERS = /[\s/?#]/

// Bind hosts that listen on every interface, in normalized form (no
// brackets, so "[::]" is covered via `stripIpv6Brackets`).
export const NORMALIZED_WILDCARD_HOSTS = new Set(["0.0.0.0", "::"])

export function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1)
  }
  return hostname
}

export function normalizeHostnameBase(hostname: string): string {
  const normalized = stripIpv6Brackets(hostname.trim())
  if (!normalized || INVALID_HOST_CHARACTERS.test(normalized)) {
    throw new Error(`Invalid server host: ${JSON.stringify(hostname)}`)
  }
  return normalized
}

export function isWildcardHostname(hostname: string): boolean {
  return NORMALIZED_WILDCARD_HOSTS.has(stripIpv6Brackets(hostname.trim()))
}
