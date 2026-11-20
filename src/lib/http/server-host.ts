import { isIP } from "node:net"

import { isWildcardHostname, normalizeHostnameBase } from "./server-host-shared"

export const DEFAULT_SERVER_HOST = "127.0.0.1"

// Listen failures that mean the hostname itself cannot be bound, as opposed
// to the port being occupied (EADDRINUSE) or forbidden (EACCES). ENOTFOUND
// covers unresolvable names such as typos, EADDRNOTAVAIL covers valid IPs
// that are not assigned to this machine.
const INVALID_BIND_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EADDRNOTAVAIL",
  "EINVAL",
  "EAFNOSUPPORT",
  "ENXIO",
])

export function isInvalidBindErrorCode(code?: string): boolean {
  return !!code && INVALID_BIND_ERROR_CODES.has(code)
}

export interface ServerBinding {
  hostname: string
  clientHostname: string
  networkExposed: boolean
}

function isLoopbackIpv4(hostname: string): boolean {
  return isIP(hostname) === 4 && hostname.split(".", 1)[0] === "127"
}

function isLoopbackMappedIpv4(hostname: string): boolean {
  try {
    const canonicalHostname = new URL(`http://[${hostname}]/`).hostname.slice(
      1,
      -1,
    )
    const mappedIpv4 = canonicalHostname.match(
      /^::ffff:([\da-f]{1,4}):[\da-f]{1,4}$/,
    )
    if (!mappedIpv4) {
      return false
    }

    return (Number.parseInt(mappedIpv4[1], 16) & 0xff00) === 0x7f00
  } catch {
    return false
  }
}

export function normalizeServerHostname(hostname: string): string {
  return normalizeHostnameBase(hostname)
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeServerHostname(hostname).toLowerCase()
  if (normalized === "localhost" || normalized === "localhost.") {
    return true
  }
  if (isLoopbackIpv4(normalized)) {
    return true
  }
  if (isIP(normalized) !== 6) {
    return false
  }

  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true
  }

  return isLoopbackMappedIpv4(normalized)
}

export function resolveServerBinding(
  hostname: string,
  hasApiKeys: boolean,
): ServerBinding {
  const normalizedHostname = normalizeServerHostname(hostname)
  const networkExposed = !isLoopbackHostname(normalizedHostname)

  if (networkExposed && !hasApiKeys) {
    throw new Error(
      `Refusing to listen on non-loopback host ${JSON.stringify(normalizedHostname)} without gateway API keys. Run \`npx @jeffreycao/copilot-api@latest auth keys --add <key>\` first, or use \`--host ${DEFAULT_SERVER_HOST}\`.`,
    )
  }

  return {
    hostname: normalizedHostname,
    clientHostname: resolveClientHostname(normalizedHostname),
    networkExposed,
  }
}

export function resolveClientHostname(hostname: string): string {
  const normalizedHostname = normalizeServerHostname(hostname)
  // Wildcard binds listen on every interface, which clients cannot dial
  // directly (0.0.0.0 is not a routable destination).
  return isWildcardHostname(normalizedHostname) ? DEFAULT_SERVER_HOST : (
      normalizedHostname.toLowerCase()
    )
}

export function resolveClientHostnameOrDefault(
  hostname: string | null | undefined,
): string {
  const normalizedHostname = hostname?.trim()
  return normalizedHostname ?
      resolveClientHostname(normalizedHostname)
    : DEFAULT_SERVER_HOST
}

export function formatServerUrl(hostname: string, port: number): string {
  const urlHostname =
    isIP(hostname) === 6 ? `[${hostname.replace("%", "%25")}]` : hostname
  return `http://${urlHostname}:${port}`
}
