import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import {
  applyCopilotTokenResponse,
  type CopilotTokenDependencies,
  logUser,
  setupCopilotToken,
  stopCopilotRefreshLoop,
} from "~/lib/auth/token"
import { state } from "~/lib/state"

type TokenResponse = {
  token: string
  refresh_in: number
  expires_at: number
  endpoints?: { api?: string }
}

const BUSINESS_API_URL = "https://api.business.githubcopilot.com"
const ENTERPRISE_API_URL = "https://api.enterprise.githubcopilot.com"

const getCopilotTokenMock = mock(
  (): Promise<TokenResponse> =>
    Promise.resolve({
      token: "copilot-token-1",
      refresh_in: 1_800,
      expires_at: 0,
    }),
)

const getCopilotUsageMock = mock(() =>
  Promise.resolve({
    login: "alice",
    copilot_plan: "enterprise",
    endpoints: {
      api: BUSINESS_API_URL,
      telemetry: "https://telemetry.business.githubcopilot.com",
    },
    token_based_billing: false,
  }),
)

const dependencies: CopilotTokenDependencies = {
  getCopilotToken: getCopilotTokenMock,
  getCopilotUsage: getCopilotUsageMock,
}

beforeEach(() => {
  state.githubToken = "github-token"
  state.copilotToken = undefined
  state.copilotApiUrl = undefined
  getCopilotTokenMock.mockClear()
  getCopilotUsageMock.mockClear()
  getCopilotTokenMock.mockImplementation(
    (): Promise<TokenResponse> =>
      Promise.resolve({
        token: "copilot-token-1",
        refresh_in: 1_800,
        expires_at: 0,
      }),
  )
})

afterEach(() => {
  stopCopilotRefreshLoop()
  delete process.env.COPILOT_API_OAUTH_APP
})

test("token exchange endpoint overrides the /user endpoints.api (enterprise seat)", async () => {
  await logUser(dependencies)
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)

  getCopilotTokenMock.mockImplementation(
    (): Promise<TokenResponse> =>
      Promise.resolve({
        token: "copilot-token-enterprise",
        refresh_in: 1_800,
        expires_at: 0,
        endpoints: { api: ENTERPRISE_API_URL },
      }),
  )

  await setupCopilotToken(dependencies)

  expect(state.copilotToken).toBe("copilot-token-enterprise")
  expect(state.copilotApiUrl).toBe(ENTERPRISE_API_URL)
})

test("keeps the /user endpoints.api when the token response carries no endpoints", async () => {
  await logUser(dependencies)
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)

  getCopilotTokenMock.mockImplementation(
    (): Promise<TokenResponse> =>
      Promise.resolve({
        token: "copilot-token-plain",
        refresh_in: 1_800,
        expires_at: 0,
      }),
  )

  await setupCopilotToken(dependencies)

  expect(state.copilotToken).toBe("copilot-token-plain")
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)
})

test("applyCopilotTokenResponse updates the token and routing URL", () => {
  state.copilotApiUrl = BUSINESS_API_URL

  applyCopilotTokenResponse({
    token: "t-enterprise",
    refresh_in: 60,
    expires_at: 0,
    endpoints: { api: ENTERPRISE_API_URL },
  })

  expect(state.copilotToken).toBe("t-enterprise")
  expect(state.copilotApiUrl).toBe(ENTERPRISE_API_URL)
})

test("applyCopilotTokenResponse keeps the previous API URL without endpoints", () => {
  state.copilotApiUrl = BUSINESS_API_URL

  applyCopilotTokenResponse({
    token: "t-plain",
    refresh_in: 60,
    expires_at: 0,
  })

  expect(state.copilotToken).toBe("t-plain")
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)
})

test("applyCopilotTokenResponse keeps an empty endpoints.api fallback", () => {
  state.copilotApiUrl = BUSINESS_API_URL

  applyCopilotTokenResponse({
    token: "t-empty",
    refresh_in: 60,
    expires_at: 0,
    endpoints: { api: undefined },
  })

  expect(state.copilotToken).toBe("t-empty")
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)
})

test("opencode oauth app mode skips token exchange and keeps the GitHub token", async () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  await setupCopilotToken(dependencies)

  expect(getCopilotTokenMock).not.toHaveBeenCalled()
  expect(state.copilotToken).toBe("github-token")
})

test("refresh loop re-applies the exchanged endpoints.api", async () => {
  await logUser(dependencies)
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)

  getCopilotTokenMock.mockImplementation(
    (): Promise<TokenResponse> =>
      Promise.resolve({
        token: "copilot-token-enterprise",
        refresh_in: 0,
        expires_at: 0,
        endpoints: { api: ENTERPRISE_API_URL },
      }),
  )

  await setupCopilotToken(dependencies)
  expect(state.copilotApiUrl).toBe(ENTERPRISE_API_URL)
  expect(getCopilotTokenMock).toHaveBeenCalledTimes(1)

  // Refresh deadline for refresh_in=0 is clamped to 1s; allow the loop to fire
  // once more with a different endpoint and verify routing follows the token.
  getCopilotTokenMock.mockImplementation(
    (): Promise<TokenResponse> =>
      Promise.resolve({
        token: "copilot-token-reloaded",
        refresh_in: 0,
        expires_at: 0,
        endpoints: { api: BUSINESS_API_URL },
      }),
  )

  await Bun.sleep(2_000)

  expect(getCopilotTokenMock.mock.calls.length).toBeGreaterThan(1)
  expect(state.copilotApiUrl).toBe(BUSINESS_API_URL)
})

test("refresh loop passes an AbortSignal to getCopilotToken and stops when aborted in-flight", async () => {
  getCopilotTokenMock.mockImplementationOnce(
    (): Promise<TokenResponse> =>
      Promise.resolve({
        token: "copilot-token-initial",
        refresh_in: 0,
        expires_at: 0,
      }),
  )

  let inFlightSignal: AbortSignal | undefined
  const startedInFlight = Promise.withResolvers<void>()
  getCopilotTokenMock.mockImplementationOnce(
    (options?: { signal?: AbortSignal }): Promise<TokenResponse> => {
      inFlightSignal = options?.signal
      startedInFlight.resolve()
      return new Promise<TokenResponse>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject(
              options.signal?.reason instanceof Error ?
                options.signal.reason
              : new Error("aborted"),
            )
          },
          { once: true },
        )
      })
    },
  )

  await setupCopilotToken(dependencies)
  await startedInFlight.promise

  expect(inFlightSignal).toBeInstanceOf(AbortSignal)
  expect(inFlightSignal?.aborted).toBe(false)

  stopCopilotRefreshLoop()

  expect(inFlightSignal?.aborted).toBe(true)
  expect(state.copilotToken).toBe("copilot-token-initial")
})
