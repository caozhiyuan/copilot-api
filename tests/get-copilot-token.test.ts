import { afterEach, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/http/error"
import { state } from "~/lib/state"
import { getCopilotToken } from "~/services/github/get-copilot-token"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("returns the token envelope including per-SKU endpoints", async () => {
  state.githubToken = "github-token"

  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          token: "copilot-token",
          expires_at: 1_800_000_000,
          refresh_in: 1_800,
          sku: "copilot_enterprise_seat_quota",
          endpoints: {
            api: "https://api.enterprise.githubcopilot.com",
            proxy: "proxy.enterprise.githubcopilot.com",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await getCopilotToken()

  expect(result.token).toBe("copilot-token")
  expect(result.endpoints?.api).toBe("https://api.enterprise.githubcopilot.com")
  expect(result.endpoints?.proxy).toBe("proxy.enterprise.githubcopilot.com")
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.github.com/copilot_internal/v2/token",
    expect.any(Object),
  )
})

test("returns a token envelope without endpoints when absent", async () => {
  state.githubToken = "github-token"

  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          token: "copilot-token",
          expires_at: 1_800_000_000,
          refresh_in: 1_800,
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const result = await getCopilotToken()

  expect(result.token).toBe("copilot-token")
  expect(result.endpoints).toBeUndefined()
})

test("throws HTTPError when the token exchange fails", () => {
  state.githubToken = "github-token"

  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("unauthorized", { status: 401 })),
  ) as unknown as typeof fetch

  expect(getCopilotToken()).rejects.toBeInstanceOf(HTTPError)
})

test("aborts an in-flight token fetch when the caller signal or timeout fires", async () => {
  state.githubToken = "github-token"
  let receivedSignal: AbortSignal | undefined

  globalThis.fetch = mock(
    (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        receivedSignal = init?.signal ?? undefined
        receivedSignal?.addEventListener(
          "abort",
          () => {
            const reason: unknown = receivedSignal?.reason
            reject(
              reason instanceof Error ? reason : (
                new Error("Token fetch aborted")
              ),
            )
          },
          { once: true },
        )
      }),
  ) as unknown as typeof fetch

  const controller = new AbortController()
  const pending = getCopilotToken({ signal: controller.signal, timeoutMs: 500 })
  controller.abort(new Error("Refresh loop stopped"))

  const error: unknown = await pending.catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe("Refresh loop stopped")
  expect(receivedSignal?.aborted).toBe(true)
})
