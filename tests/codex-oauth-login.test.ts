import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { createServer } from "node:http"

import {
  loginCodex,
  CodexOAuthError,
  type CodexCredentials,
  type LoginCodexOptions,
} from "~/lib/auth/oauth/codex"

const originalFetch = globalThis.fetch
const callbackBaseUrl = "http://127.0.0.1:1455"
const accessToken = `header.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  }),
).toString("base64url")}.signature`
let tokenResponse: Response
const exchange = mock(
  (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Promise.resolve(tokenResponse),
)

beforeEach(() => {
  tokenResponse = Response.json({
    access_token: accessToken,
    refresh_token: "test-refresh-token",
    expires_in: 3600,
  })
  exchange.mockClear()
  globalThis.fetch = Object.assign(exchange, { preconnect: () => {} })
})

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
})

async function startLogin(options: Partial<LoginCodexOptions> = {}) {
  const published = Promise.withResolvers<string>()
  const outcome: Promise<CodexCredentials | Error> = loginCodex({
    ...options,
    onAuth(info) {
      published.resolve(info.url)
      return options.onAuth?.(info)
    },
    onPrompt: options.onPrompt ?? (() => Promise.resolve("")),
  }).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error
    return error
  })
  return { url: new URL(await published.promise), outcome }
}

async function callback(path: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await originalFetch(`${callbackBaseUrl}${path}`)
    } catch (error) {
      if (attempt === 99) throw error
      await Bun.sleep(2)
    }
  }
  throw new Error("Callback listener did not start")
}

async function occupyCallbackPort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(1455, "127.0.0.1", resolve)
  })
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
}

describe("Codex browser authorization", () => {
  test("publishes the authorization URL and accepts a matching callback", async () => {
    const prompt = mock(() => Promise.resolve(""))
    const signal = new AbortController().signal
    const { url, outcome } = await startLogin({ onPrompt: prompt, signal })
    expect(url.origin).toBe("https://auth.openai.com")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    )
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    const response = await callback(
      `/auth/callback?state=${url.searchParams.get("state")}&code=test-code`,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Authentication successful")
    expect(await outcome).toMatchObject({
      accessToken,
      refreshToken: "test-refresh-token",
      accountId: "acct_test",
    })
    expect(prompt).not.toHaveBeenCalled()
    expect(exchange).toHaveBeenCalledTimes(1)
    const init = exchange.mock.calls[0]?.[1]
    expect(init?.signal).toBe(signal)
    expect((init?.body as URLSearchParams).get("code")).toBe("test-code")
  })

  test("ignores invalid callbacks and cancels without exchanging or prompting", async () => {
    const controller = new AbortController()
    const removeListener = spyOn(controller.signal, "removeEventListener")
    const prompt = mock(() => Promise.resolve(""))
    const { url, outcome } = await startLogin({
      signal: controller.signal,
      onPrompt: prompt,
    })
    expect((await callback("/wrong-route")).status).toBe(404)
    expect((await callback("/auth/callback?state=wrong&code=x")).status).toBe(
      400,
    )
    expect(
      (await callback(`/auth/callback?state=${url.searchParams.get("state")}`))
        .status,
    ).toBe(400)
    controller.abort(new Error("Cancelled by user"))
    expect(await outcome).toEqual(new Error("Cancelled by user"))
    expect(prompt).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
    const close = await occupyCallbackPort()
    await close()
  })

  test("uses a two-minute deadline and releases the listener on timeout", async () => {
    const timer = spyOn(globalThis, "setTimeout")
    const prompt = mock(() => Promise.resolve(""))
    const { outcome } = await startLogin({ onPrompt: prompt })
    await callback("/wrong-route")
    const timeout = timer.mock.calls.find(([, delay]) => delay === 120_000)
    expect(timeout?.[1]).toBe(120_000)
    timeout?.[0](undefined)
    expect(((await outcome) as Error).message).toBe(
      "Codex authorization timed out after 2 minutes",
    )
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(exchange).not.toHaveBeenCalled()
    const close = await occupyCallbackPort()
    await close()
  })

  test("rejects an already cancelled login before publishing a URL", async () => {
    const controller = new AbortController()
    controller.abort(new Error("Cancelled before starting"))
    const onAuth = mock(() => {})
    const error = await loginCodex({
      onAuth,
      onPrompt: () => Promise.resolve(""),
      signal: controller.signal,
    }).catch((failure: unknown) => failure)
    expect(error).toEqual(new Error("Cancelled before starting"))
    expect(onAuth).not.toHaveBeenCalled()
    expect(exchange).not.toHaveBeenCalled()
  })

  test("reports an unavailable callback listener instead of a missing code", async () => {
    const close = await occupyCallbackPort()
    try {
      const { outcome } = await startLogin()
      const error = await outcome
      expect(error).toBeInstanceOf(CodexOAuthError)
      expect((error as CodexOAuthError).reason).toBe("callback_unavailable")
      expect((error as Error).message).toContain("port 1455")
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  test("cancels during URL publication without starting a callback listener", async () => {
    const controller = new AbortController()
    const { outcome } = await startLogin({
      signal: controller.signal,
      onAuth: () => controller.abort(new Error("Cancelled before waiting")),
    })
    expect(await outcome).toEqual(new Error("Cancelled before waiting"))
    expect(exchange).not.toHaveBeenCalled()
    const close = await occupyCallbackPort()
    await close()
  })

  test("aborts a pending token exchange after a callback", async () => {
    const controller = new AbortController()
    const exchanging = Promise.withResolvers<void>()
    exchange.mockImplementationOnce((_input, init) => {
      exchanging.resolve()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error ?
                init.signal.reason
              : new Error("Token exchange cancelled"),
            ),
          {
            once: true,
          },
        )
      })
    })
    const { url, outcome } = await startLogin({ signal: controller.signal })
    await callback(
      `/auth/callback?state=${url.searchParams.get("state")}&code=x`,
    )
    await exchanging.promise
    controller.abort(new Error("Cancelled during exchange"))
    expect(await outcome).toEqual(new Error("Cancelled during exchange"))
  })

  test.each([
    "test-code",
    "test-code#",
    "code=test-code",
    "http://localhost/?code=test-code",
  ])("preserves manual callback fallback for %s", async (input) => {
    const close = await occupyCallbackPort()
    try {
      const { outcome } = await startLogin({
        onPrompt: () => Promise.resolve(input),
      })
      expect(await outcome).toMatchObject({ accountId: "acct_test" })
      const init = exchange.mock.calls[0]?.[1]
      expect((init?.body as URLSearchParams).get("code")).toBe("test-code")
    } finally {
      await close()
    }
  })

  test("rejects a manual callback with a mismatched state", async () => {
    const close = await occupyCallbackPort()
    try {
      const { outcome } = await startLogin({
        onPrompt: () => Promise.resolve("http://localhost/?code=x&state=wrong"),
      })
      expect(await outcome).toEqual(new Error("Codex OAuth state mismatch"))
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  test.each([
    [Response.json({}, { status: 400 }), "Codex token exchange failed (400)"],
    [
      Response.json({ access_token: "secret" }),
      "Codex token exchange response missing required fields",
    ],
    [
      Response.json({
        access_token: "invalid",
        refresh_token: "test",
        expires_in: 3600,
      }),
      "Failed to extract Codex account id",
    ],
  ])("rejects invalid token responses: %s", async (response, message) => {
    tokenResponse = response
    const close = await occupyCallbackPort()
    try {
      const { outcome } = await startLogin({
        onPrompt: () => Promise.resolve("code"),
      })
      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(message)
    } finally {
      await close()
    }
  })
})
