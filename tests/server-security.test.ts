import { describe, expect, spyOn, test } from "bun:test"

import * as config from "~/lib/config"

import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  isInvalidBindErrorCode,
  isLoopbackHostname,
  resolveClientHostname,
  resolveClientHostnameOrDefault,
  resolveServerBinding,
} from "~/lib/http/server-host"
import { createServer } from "~/server"
import * as subscriptions from "~/services/subscription-usage"

describe("server host security", () => {
  test("recognizes explicit loopback hosts", () => {
    expect(DEFAULT_SERVER_HOST).toBe("127.0.0.1")
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("127.0.0.2")).toBe(true)
    expect(isLoopbackHostname("[::1]")).toBe(true)
    expect(isLoopbackHostname("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("0:0::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("0.0.0.0")).toBe(false)
    expect(isLoopbackHostname("::")).toBe(false)
    expect(isLoopbackHostname("2001:db8::ffff:127.0.0.1")).toBe(false)
    expect(isLoopbackHostname("gateway.example.com")).toBe(false)
  })

  test("rejects non-loopback bindings without gateway api keys", () => {
    expect(() => resolveServerBinding("0.0.0.0", false)).toThrow(
      "Refusing to listen on non-loopback host",
    )
    expect(resolveServerBinding("0.0.0.0", true)).toEqual({
      hostname: "0.0.0.0",
      clientHostname: "127.0.0.1",
      networkExposed: true,
    })
    expect(resolveServerBinding("[::1]", false)).toEqual({
      hostname: "::1",
      clientHostname: "::1",
      networkExposed: false,
    })
    expect(() =>
      resolveServerBinding("2001:db8::ffff:127.0.0.1", false),
    ).toThrow("Refusing to listen on non-loopback host")
  })

  test("formats IPv4 and IPv6 listener URLs", () => {
    expect(formatServerUrl("127.0.0.1", 4141)).toBe("http://127.0.0.1:4141")
    expect(formatServerUrl("::1", 4141)).toBe("http://[::1]:4141")
  })

  test("dials wildcard binds through loopback", () => {
    expect(resolveClientHostname("0.0.0.0")).toBe("127.0.0.1")
    expect(resolveClientHostname("[::]")).toBe("127.0.0.1")
    expect(resolveClientHostname("::")).toBe("127.0.0.1")
    expect(resolveClientHostname("192.168.1.10")).toBe("192.168.1.10")
    expect(resolveClientHostname("127.0.0.1")).toBe("127.0.0.1")
  })

  test("falls back to loopback for a blank desktop host", () => {
    expect(resolveClientHostnameOrDefault("")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("   ")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault(null)).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault(undefined)).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("0.0.0.0")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("  ::  ")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("  192.168.1.10  ")).toBe(
      "192.168.1.10",
    )
    expect(resolveClientHostnameOrDefault("::1")).toBe("::1")
  })
  test("classifies unbindable host errors separately from occupied ports", () => {
    expect(isInvalidBindErrorCode("ENOTFOUND")).toBe(true)
    expect(isInvalidBindErrorCode("EADDRNOTAVAIL")).toBe(true)
    expect(isInvalidBindErrorCode("EINVAL")).toBe(true)
    expect(isInvalidBindErrorCode("EAFNOSUPPORT")).toBe(true)
    expect(isInvalidBindErrorCode(undefined)).toBe(false)
    expect(isInvalidBindErrorCode("EADDRINUSE")).toBe(false)
    expect(isInvalidBindErrorCode("EACCES")).toBe(false)
  })
})

describe("network-exposed server policy", () => {
  test("keeps subscription usage available to the admin when regular keys are isolated", async () => {
    const usage = {
      provider: "codex" as const,
      planType: "business",
      windows: [],
      limitReached: false,
    }
    const configSpy = spyOn(config, "getConfig").mockReturnValue({
      auth: {
        adminApiKey: "admin",
        apiKeyConfigs: [{ id: "regular", key: "regular" }],
        isolateApiKeyUsage: true,
      },
    })
    const usageSpy = spyOn(
      subscriptions,
      "getSubscriptionUsage",
    ).mockResolvedValue(usage)
    try {
      const app = createServer()
      const request = (path: string, key: string) =>
        app.request(path, { headers: { "x-api-key": key } })
      expect((await request("/usage/codex", "regular")).status).toBe(403)
      expect((await request("/admin/usage/codex", "regular")).status).toBe(401)
      const response = await request("/admin/usage/codex", "admin")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(usage)
      expect(usageSpy).toHaveBeenCalledTimes(1)
    } finally {
      usageSpy.mockRestore()
      configSpy.mockRestore()
    }
  })

  test("requires authentication for protected routes when no keys exist", async () => {
    const app = createServer({
      networkExposed: true,
      getApiKeys: () => [],
    })
    const response = await app.request("http://gateway.example.com/usage")

    expect(response.status).toBe(401)
  })

  test("allows only the request origin through CORS", async () => {
    const app = createServer({ networkExposed: true })
    const sameOriginResponse = await app.request(
      "http://gateway.example.com/",
      { headers: { origin: "http://gateway.example.com" } },
    )
    const crossOriginResponse = await app.request(
      "http://gateway.example.com/",
      { headers: { origin: "https://attacker.example.com" } },
    )

    expect(sameOriginResponse.headers.get("access-control-allow-origin")).toBe(
      "http://gateway.example.com",
    )
    expect(crossOriginResponse.headers.has("access-control-allow-origin")).toBe(
      false,
    )
  })

  test("keeps wildcard CORS for the default loopback server", async () => {
    const app = createServer()
    const response = await app.request("http://127.0.0.1/", {
      headers: { origin: "https://client.example.com" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-API-Key-Usage-Isolated",
    )
  })
})
