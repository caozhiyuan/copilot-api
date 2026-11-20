import consola from "consola"

import { getOauthAppConfig, getOauthUrls } from "~/lib/providers/api-config"

import type { DeviceCodeResponse } from "./get-device-code"

// RFC 8628 section 3.5: every slow_down adds 5 seconds to the poll interval.
const SLOW_DOWN_INTERVAL_INCREMENT_SECONDS = 5

const defaultSleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export interface PollAccessTokenDependencies {
  now: () => number
  sleep: (ms: number) => Promise<unknown>
}

export interface PollAccessTokenOptions {
  // Stops polling; the returned promise rejects with the signal's reason.
  signal?: AbortSignal
}

const defaultPollAccessTokenDependencies: PollAccessTokenDependencies = {
  now: () => Date.now(),
  sleep: defaultSleep,
}

// Interval is in seconds, we need to multiply by 1000 to get milliseconds
// I'm also adding another second, just to be safe
const toSleepDuration = (intervalSeconds: number) =>
  (intervalSeconds + 1) * 1000

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  dependencies: PollAccessTokenDependencies = defaultPollAccessTokenDependencies,
  options: PollAccessTokenOptions = {},
): Promise<string> {
  const { signal } = options
  const { clientId, headers } = getOauthAppConfig()
  const { accessTokenUrl } = getOauthUrls()
  const expiresAt = dependencies.now() + deviceCode.expires_in * 1000
  let intervalSeconds = deviceCode.interval

  consola.debug(
    `Polling access token with interval of ${toSleepDuration(intervalSeconds)}ms`,
  )

  while (true) {
    signal?.throwIfAborted()

    if (dependencies.now() >= expiresAt) {
      throw new Error(
        "GitHub device code expired before authorization completed. Please log in again.",
      )
    }

    const json = await requestAccessToken(accessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    })

    if (json) {
      consola.debug("Polling access token response received")

      if (json.access_token) {
        return json.access_token
      }

      if (json.error === "slow_down") {
        const serverInterval =
          typeof json.interval === "number" ? json.interval : 0
        intervalSeconds = Math.max(
          serverInterval,
          intervalSeconds + SLOW_DOWN_INTERVAL_INCREMENT_SECONDS,
        )
        consola.debug(
          `GitHub asked to slow down, polling interval is now ${intervalSeconds}s`,
        )
      } else if (json.error && json.error !== "authorization_pending") {
        throw new Error(
          `GitHub device authorization failed: ${json.error_description ?? json.error}`,
        )
      }
    }

    await sleepUnlessAborted(
      dependencies.sleep,
      toSleepDuration(intervalSeconds),
      signal,
    )
  }
}

async function sleepUnlessAborted(
  sleepFor: PollAccessTokenDependencies["sleep"],
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await sleepFor(ms)
    return
  }

  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  // Listen before starting the sleep so an abort during it is never missed.
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as Error)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    await Promise.race([aborted, sleepFor(ms)])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/**
 * Resolves to `undefined` when the poll should simply be retried. The device
 * code stays valid until it expires, so a dropped connection (for example a
 * proxy closing the socket) or a non-2xx response must not abort the login.
 * A request aborted through `init.signal` rejects instead.
 */
async function requestAccessToken(
  url: string,
  init: RequestInit,
): Promise<AccessTokenResponse | undefined> {
  try {
    const response = await fetch(url, init)

    if (!response.ok) {
      consola.error("Failed to poll access token:", await response.text())
      return undefined
    }

    return (await response.json()) as AccessTokenResponse
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }

    consola.warn(
      `Failed to poll access token, will retry: ${describeError(error)}`,
    )
    return undefined
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  // Node's fetch rejects with "fetch failed" and keeps the reason in `cause`
  const { cause } = error
  if (!(cause instanceof Error)) {
    return error.message
  }

  const detail = cause.message || (cause as NodeJS.ErrnoException).code
  return detail ? `${error.message} (${detail})` : error.message
}

interface AccessTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
  interval?: number
}
