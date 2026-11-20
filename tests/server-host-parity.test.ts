import { describe, expect, test } from "bun:test"

import {
  normalizeServerHostname,
  resolveClientHostname,
} from "~/lib/http/server-host"
import { normalizeHostnameBase } from "~/lib/http/server-host-shared"
import {
  buildServerBaseUrl,
  isValidServerHost,
  resolveDisplayHost,
} from "../desktop/src/lib/server-url"

// Guards the contract between the gateway (Node, node:net) and the desktop
// renderer (web bundle, no node:*): both sides share
// src/lib/server-host-shared.ts, and this test fails if either side drifts.
describe("server host parity between gateway and desktop", () => {
  test("wildcards dial loopback on the server and display localhost", () => {
    for (const host of ["0.0.0.0", "::", "[::]", "  ::  "]) {
      expect(resolveClientHostname(host)).toBe("127.0.0.1")
      expect(resolveDisplayHost(host)).toBe("localhost")
    }
    // Bracketed IPv4 wildcards normalize to a wildcard instead of leaking
    // into a display URL such as http://[0.0.0.0]:4141.
    expect(resolveDisplayHost("[0.0.0.0]")).toBe("localhost")
  })

  test("validation agrees on supported and rejected hosts", () => {
    const validHosts = [
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      "0.0.0.0",
      "desktop.local",
      "192.168.1.10",
    ]
    for (const host of validHosts) {
      expect(() => normalizeServerHostname(host)).not.toThrow()
      expect(() => normalizeHostnameBase(host)).not.toThrow()
      expect(isValidServerHost(host)).toBe(true)
    }

    const invalidHosts = [
      "127.0.0.1 8080",
      "http://127.0.0.1",
      "127.0.0.1/usage",
      "127.0.0.1?x=1",
      "127.0.0.1#x",
      "[]",
    ]
    for (const host of invalidHosts) {
      expect(() => normalizeServerHostname(host)).toThrow()
      expect(() => normalizeHostnameBase(host)).toThrow()
      expect(isValidServerHost(host)).toBe(false)
    }

    // Blank means "use the default host": the dashboard keeps it valid while
    // the server-side normalizer (correctly) refuses an empty hostname.
    expect(isValidServerHost("")).toBe(true)
    expect(isValidServerHost("   ")).toBe(true)
    expect(() => normalizeServerHostname("")).toThrow()
  })

  test("non-wildcard hosts pass through on both sides", () => {
    expect(resolveClientHostname("192.168.1.10")).toBe("192.168.1.10")
    expect(resolveDisplayHost("192.168.1.10")).toBe("192.168.1.10")
    expect(buildServerBaseUrl("0.0.0.0", 4141)).toBe("http://localhost:4141")
    expect(buildServerBaseUrl("::1", 4141)).toBe("http://[::1]:4141")
  })
})
