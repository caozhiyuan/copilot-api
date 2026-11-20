import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"

import { getGrokBuildVersion } from "~/lib/providers/grok-build"

const originalFetch = globalThis.fetch
const dayMs = 24 * 60 * 60 * 1000
let now = Date.now()
const fetchMock = mock(
  (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Promise.resolve(new Response("1.0.47\n")),
)

beforeEach(() => {
  now += 2 * dayMs
  spyOn(Date, "now").mockImplementation(() => now)
  fetchMock.mockClear()
  globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe("Grok Build client version", () => {
  test("uses the verified fallback when the stable channel is unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    expect(await getGrokBuildVersion()).toBe("1.0.46")
    expect(await getGrokBuildVersion()).toBe("1.0.46")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("reads the official stable channel and shares a cached lookup across requests", async () => {
    expect(
      await Promise.all(Array.from({ length: 8 }, getGrokBuildVersion)),
    ).toEqual(Array.from({ length: 8 }, () => "1.0.47"))
    expect(await getGrokBuildVersion()).toBe("1.0.47")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("https://x.ai/cli/stable")
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock.mock.calls[0][1]?.headers).toBeUndefined()
  })

  test("updates daily and retries failed lookups while retaining the last good version", async () => {
    expect(await getGrokBuildVersion()).toBe("1.0.47")
    now += dayMs
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    expect(await getGrokBuildVersion()).toBe("1.0.47")
    expect(await getGrokBuildVersion()).toBe("1.0.47")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    now += 5 * 60 * 1000
    fetchMock.mockResolvedValueOnce(new Response("1.0.48"))
    expect(await getGrokBuildVersion()).toBe("1.0.48")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test.each([
    new Response("1.0.49", { status: 503 }),
    new Response("<html>unavailable</html>"),
    new Response("1.0.49\ninvalid-header"),
  ])(
    "ignores failed or invalid stable channel responses (%j)",
    async (response) => {
      expect(await getGrokBuildVersion()).toBe("1.0.47")
      now += dayMs
      fetchMock.mockResolvedValueOnce(response)
      expect(await getGrokBuildVersion()).toBe("1.0.47")
    },
  )
})
