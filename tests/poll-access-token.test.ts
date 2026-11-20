import { afterEach, beforeEach, expect, test } from "bun:test"
import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/providers/api-config"
import type { DeviceCodeResponse } from "~/services/github/get-device-code"
import {
  pollAccessToken,
  type PollAccessTokenDependencies,
} from "~/services/github/poll-access-token"

const originalFetch = globalThis.fetch
const originalDebug = consola.debug
const originalWarn = consola.warn
const originalError = consola.error

let warnings: Array<string> = []
let errors: Array<Array<unknown>> = []

const deviceCode: DeviceCodeResponse = {
  device_code: "device-code",
  expires_in: 900,
  interval: 5,
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
}

const tokenResponse = () =>
  Response.json({
    access_token: "gho_test_token",
    scope: "read:user",
    token_type: "bearer",
  })

const socketClosedError = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    }),
  })

function mockFetch(
  respond: (attempt: number) => Promise<Response>,
): Array<{ input: unknown; init?: RequestInit }> {
  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return respond(calls.length)
  }) as unknown as typeof fetch
  return calls
}

function createFakeClock() {
  let now = 0
  const sleeps: Array<number> = []
  const dependencies: PollAccessTokenDependencies = {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
  return { dependencies, sleeps }
}

beforeEach(() => {
  warnings = []
  errors = []
  consola.debug = ((..._args: Array<unknown>) => {}) as typeof consola.debug
  consola.warn = ((message: string) => {
    warnings.push(message)
  }) as typeof consola.warn
  consola.error = ((...args: Array<unknown>) => {
    errors.push(args)
  }) as typeof consola.error
})

afterEach(() => {
  globalThis.fetch = originalFetch
  consola.debug = originalDebug
  consola.warn = originalWarn
  consola.error = originalError
})

test("retries the poll when the connection is closed by the other side", async () => {
  const calls = mockFetch((attempt) =>
    attempt === 1 ?
      Promise.reject(socketClosedError())
    : Promise.resolve(tokenResponse()),
  )
  const { dependencies, sleeps } = createFakeClock()

  const token = await pollAccessToken(deviceCode, dependencies)

  expect(token).toBe("gho_test_token")
  expect(calls).toHaveLength(2)
  expect(sleeps).toEqual([6_000])
  expect(warnings).toEqual([
    "Failed to poll access token, will retry: fetch failed (other side closed)",
  ])
})

test("sends the device code grant to the access token endpoint", async () => {
  const calls = mockFetch(() => Promise.resolve(tokenResponse()))
  const { dependencies } = createFakeClock()

  await pollAccessToken(deviceCode, dependencies)

  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toBe(getOauthUrls().accessTokenUrl)
  expect(calls[0]?.init?.method).toBe("POST")
  expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
    client_id: getOauthAppConfig().clientId,
    device_code: "device-code",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  })
})

test("retries when the response body is cut off mid-stream", async () => {
  mockFetch((attempt) =>
    Promise.resolve(
      attempt === 1 ?
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"))
            },
          }),
        )
      : tokenResponse(),
    ),
  )
  const { dependencies, sleeps } = createFakeClock()

  const token = await pollAccessToken(deviceCode, dependencies)

  expect(token).toBe("gho_test_token")
  expect(sleeps).toEqual([6_000])
  expect(warnings).toEqual([
    "Failed to poll access token, will retry: terminated",
  ])
})

test("describes connection errors that only carry an error code", async () => {
  mockFetch((attempt) =>
    attempt === 1 ?
      Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new AggregateError([], ""), {
            code: "ECONNREFUSED",
          }),
        }),
      )
    : Promise.resolve(tokenResponse()),
  )
  const { dependencies } = createFakeClock()

  await pollAccessToken(deviceCode, dependencies)

  expect(warnings).toEqual([
    "Failed to poll access token, will retry: fetch failed (ECONNREFUSED)",
  ])
})

test("describes non-Error rejections and causes without details", async () => {
  mockFetch((attempt) => {
    if (attempt === 1) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject("socket hang up")
    }
    if (attempt === 2) {
      return Promise.reject(
        new TypeError("fetch failed", { cause: new Error("") }),
      )
    }
    return Promise.resolve(tokenResponse())
  })
  const { dependencies } = createFakeClock()

  await pollAccessToken(deviceCode, dependencies)

  expect(warnings).toEqual([
    "Failed to poll access token, will retry: socket hang up",
    "Failed to poll access token, will retry: fetch failed",
  ])
})

test("retries non-2xx responses from GitHub", async () => {
  mockFetch((attempt) =>
    Promise.resolve(
      attempt === 1 ?
        new Response("upstream unavailable", { status: 502 })
      : tokenResponse(),
    ),
  )
  const { dependencies, sleeps } = createFakeClock()

  const token = await pollAccessToken(deviceCode, dependencies)

  expect(token).toBe("gho_test_token")
  expect(sleeps).toEqual([6_000])
  expect(errors).toEqual([
    ["Failed to poll access token:", "upstream unavailable"],
  ])
})

test("keeps polling while authorization is pending", async () => {
  const calls = mockFetch((attempt) =>
    Promise.resolve(
      attempt < 3 ?
        Response.json({ error: "authorization_pending" })
      : tokenResponse(),
    ),
  )
  const { dependencies, sleeps } = createFakeClock()

  const token = await pollAccessToken(deviceCode, dependencies)

  expect(token).toBe("gho_test_token")
  expect(calls).toHaveLength(3)
  expect(sleeps).toEqual([6_000, 6_000])
})

test("uses the interval returned with slow_down for later polls", async () => {
  mockFetch((attempt) => {
    if (attempt === 1) {
      return Promise.resolve(
        Response.json({ error: "slow_down", interval: 15 }),
      )
    }
    if (attempt === 2) {
      return Promise.resolve(Response.json({ error: "authorization_pending" }))
    }
    return Promise.resolve(tokenResponse())
  })
  const { dependencies, sleeps } = createFakeClock()

  await pollAccessToken(deviceCode, dependencies)

  expect(sleeps).toEqual([16_000, 16_000])
})

test("adds five seconds to the interval when slow_down omits it", async () => {
  mockFetch((attempt) =>
    Promise.resolve(
      attempt < 3 ? Response.json({ error: "slow_down" }) : tokenResponse(),
    ),
  )
  const { dependencies, sleeps } = createFakeClock()

  await pollAccessToken(deviceCode, dependencies)

  expect(sleeps).toEqual([11_000, 16_000])
})

test("stops polling when the user denies the authorization", async () => {
  const calls = mockFetch(() =>
    Promise.resolve(
      Response.json({
        error: "access_denied",
        error_description: "The authorization request was denied.",
      }),
    ),
  )
  const { dependencies, sleeps } = createFakeClock()

  const failure = await pollAccessToken(deviceCode, dependencies).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(
    "GitHub device authorization failed: The authorization request was denied.",
  )
  expect(calls).toHaveLength(1)
  expect(sleeps).toEqual([])
})

test("reports the error code when GitHub omits a description", async () => {
  mockFetch(() => Promise.resolve(Response.json({ error: "expired_token" })))
  const { dependencies } = createFakeClock()

  const failure = await pollAccessToken(deviceCode, dependencies).then(
    () => null,
    (error: unknown) => error,
  )

  expect((failure as Error).message).toBe(
    "GitHub device authorization failed: expired_token",
  )
})

test("gives up once the device code has expired", async () => {
  const calls = mockFetch(() => Promise.reject(socketClosedError()))
  const { dependencies, sleeps } = createFakeClock()

  const failure = await pollAccessToken(
    { ...deviceCode, expires_in: 30 },
    dependencies,
  ).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(
    "GitHub device code expired before authorization completed. Please log in again.",
  )
  // Polls at 0s, 6s, 12s, 18s and 24s; the 30s deadline ends the loop.
  expect(calls).toHaveLength(5)
  expect(sleeps).toEqual([6_000, 6_000, 6_000, 6_000, 6_000])
})

test("does not poll when the signal is already aborted", async () => {
  const calls = mockFetch(() => Promise.resolve(tokenResponse()))
  const { dependencies } = createFakeClock()
  const controller = new AbortController()
  controller.abort()

  const failure = await pollAccessToken(deviceCode, dependencies, {
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  )

  expect((failure as Error).name).toBe("AbortError")
  expect(calls).toHaveLength(0)
})

test("stops waiting between polls when the signal is aborted", async () => {
  const calls = mockFetch(() =>
    Promise.resolve(Response.json({ error: "authorization_pending" })),
  )
  const controller = new AbortController()
  const sleeps: Array<number> = []
  const dependencies: PollAccessTokenDependencies = {
    now: () => 0,
    sleep: (ms) => {
      sleeps.push(ms)
      controller.abort()
      return new Promise(() => {})
    },
  }

  const failure = await pollAccessToken(deviceCode, dependencies, {
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  )

  expect((failure as Error).name).toBe("AbortError")
  expect(calls).toHaveLength(1)
  expect(calls[0]?.init?.signal).toBe(controller.signal)
  expect(sleeps).toEqual([6_000])
})

test("does not retry a poll request aborted in flight", async () => {
  const controller = new AbortController()
  const calls = mockFetch(() => {
    controller.abort()
    return Promise.reject(controller.signal.reason as Error)
  })
  const { dependencies, sleeps } = createFakeClock()

  const failure = await pollAccessToken(deviceCode, dependencies, {
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  )

  expect((failure as Error).name).toBe("AbortError")
  expect(calls).toHaveLength(1)
  expect(sleeps).toEqual([])
  expect(warnings).toEqual([])
})

test("polls normally when a signal is provided but not aborted", async () => {
  const calls = mockFetch((attempt) =>
    Promise.resolve(
      attempt === 1 ?
        Response.json({ error: "authorization_pending" })
      : tokenResponse(),
    ),
  )
  const { dependencies, sleeps } = createFakeClock()
  const controller = new AbortController()

  const token = await pollAccessToken(deviceCode, dependencies, {
    signal: controller.signal,
  })

  expect(token).toBe("gho_test_token")
  expect(calls).toHaveLength(2)
  expect(sleeps).toEqual([6_000])
})
