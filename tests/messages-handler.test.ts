import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AccountRuntime } from "~/lib/types/account"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { getSmallModel } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getUUID } from "~/lib/utils"
import { messageRoutes } from "~/routes/messages/route"

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type FetchOptions = {
  body?: unknown
}

const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)

function parseFetchBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new TypeError("Expected fetch body to be a JSON string")
  }

  return JSON.parse(body) as Record<string, unknown>
}

function buildAccount(): AccountRuntime {
  return {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghu_test",
    copilotToken: "copilot_test",
    vsCodeVersion: "1.0.0",
    premiumRemaining: 10,
    unlimited: false,
  }
}

function buildModel(id: string): Model {
  return {
    id,
    name: id,
    vendor: "upstream",
    object: "model",
    preview: false,
    version: "test",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      limits: {
        max_output_tokens: 8192,
        max_prompt_tokens: 200_000,
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function buildSelection(endpoint: string, modelId: string): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
  }
}

function buildAnthropicResponse(model: string, text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
  }
}

function buildResponsesResult(model: string, text: string) {
  return {
    id: "resp_1",
    object: "response",
    created_at: Date.now(),
    model,
    output: [
      {
        id: "out_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    output_text: text,
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
  }
}

function buildChatCompletionResponse(model: string, text: string) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
}

function createPayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "original-model",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection("/v1/messages", "messages-model"))
  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}
})

afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed
})

describe("messages handler routing", () => {
  test("routes to the Messages API when selection chooses /v1/messages", async () => {
    let requestedUrl = ""
    let upstreamBody: Record<string, unknown> | undefined

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/v1/messages", "messages-model"))

    const fetchMock = mock((url: string, opts?: FetchOptions) => {
      requestedUrl = url
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "messages")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const body = (await response.json()) as {
      content: Array<{ text: string }>
    }

    expect(response.status).toBe(200)
    expect(requestedUrl).toContain("/v1/messages")
    expect(upstreamBody?.model).toBe("messages-model")
    expect(body.content[0].text).toBe("messages")
  })

  test("routes to the Responses API when selection chooses /responses", async () => {
    let requestedUrl = ""
    let upstreamBody: Record<string, unknown> | undefined

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/responses", "responses-model"))

    const fetchMock = mock((url: string, opts?: FetchOptions) => {
      requestedUrl = url
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "responses")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const body = (await response.json()) as {
      content: Array<{ text: string }>
    }

    expect(response.status).toBe(200)
    expect(requestedUrl).toContain("/responses")
    expect(upstreamBody?.model).toBe("responses-model")
    expect(body.content[0].text).toBe("responses")
  })

  test("falls back to Chat Completions when selection chooses /chat/completions", async () => {
    let requestedUrl = ""
    let upstreamBody: Record<string, unknown> | undefined

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/chat/completions", "chat-model"))

    const fetchMock = mock((url: string, opts?: FetchOptions) => {
      requestedUrl = url
      upstreamBody = parseFetchBody(opts?.body)

      return Promise.resolve(
        new Response(
          JSON.stringify(buildChatCompletionResponse("chat-model", "chat")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    const body = (await response.json()) as {
      content: Array<{ text: string }>
    }

    expect(response.status).toBe(200)
    expect(requestedUrl).toContain("/chat/completions")
    expect(upstreamBody?.model).toBe("chat-model")
    expect(body.content[0].text).toBe("chat")
  })
})

describe("messages handler affinity context", () => {
  test("warmup requests switch candidate model before account selection", async () => {
    let selectionCandidates: Array<{ modelId: string; endpoint: string }> = []
    let selectionRequestId: string | undefined

    accountsManager.selectAccountForRequest = (candidates, options) => {
      selectionCandidates = candidates
      selectionRequestId = options?.requestId

      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "warmup")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const payload = createPayload({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session","agent_id":"agent-1","agent_type":"Explore"}</system-reminder>',
            },
            {
              type: "text",
              text: "hello",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    })

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "warmup-beta",
          "x-session-id": "session-123",
        },
        body: JSON.stringify(payload),
      }),
    )

    const expectedSessionId = getUUID("session-123")

    expect(response.status).toBe(200)
    expect(selectionCandidates[0]?.modelId).toBe(getSmallModel())
    expect(selectionCandidates[0]?.endpoint).toBe("/v1/messages")
    expect(selectionRequestId).toBe(expectedSessionId)
  })

  test("metadata session_id takes priority over x-session-id header for affinity key", async () => {
    let selectionRequestId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionRequestId = options?.requestId
      return Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    }

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(buildAnthropicResponse("messages-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const metadataSessionId = "metadata-session-id-123"
    const payload = createPayload({
      metadata: {
        user_id: JSON.stringify({
          device_id: "device-1",
          session_id: metadataSessionId,
        }),
      },
    })

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "header-session-should-be-ignored",
        },
        body: JSON.stringify(payload),
      }),
    )

    expect(response.status).toBe(200)
    expect(selectionRequestId).toBe(getUUID(metadataSessionId))
  })
})

describe("messages handler unauthorized classification", () => {
  test("ownership mismatch 401 does not trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() =>
      Promise.reject(
        new HTTPError(
          'input item ID "msg_abc" does not belong to this connection',
          new Response("ownership mismatch", { status: 401 }),
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    expect(response.status).toBe(401)
    expect(markFailedSpy).not.toHaveBeenCalled()
  })

  test("genuine unauthorized 401 does trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})

    accountsManager.selectAccountForRequest = () =>
      Promise.resolve(buildSelection("/v1/messages", "messages-model"))
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() =>
      Promise.reject(
        new HTTPError(
          "Unauthorized",
          new Response("unauthorized", { status: 401 }),
        ),
      ),
    )

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createPayload()),
      }),
    )

    expect(response.status).toBe(401)
    expect(markFailedSpy).toHaveBeenCalledTimes(1)
    expect(markFailedSpy).toHaveBeenCalledWith("octocat", "Unauthorized (401)")
  })
})
