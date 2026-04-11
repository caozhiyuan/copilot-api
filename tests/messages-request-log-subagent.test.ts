import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import "./shared-admin-db-test-home"

import type { AccountRuntime } from "~/lib/types/account"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

const [{ accountsManager }, { getAdminDb }, { state }, { messageRoutes }] =
  await Promise.all([
    import("~/lib/accounts-manager"),
    import("~/lib/admin-db"),
    import("~/lib/state"),
    import("~/routes/messages/route"),
  ])

type RequestLogSnapshot = {
  initiator: string | null
  is_subagent: number | null
  affinity_key_used: string | null
  affinity_key_source: string | null
  selection_reason: string | null
}

const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)

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

function buildSelection(endpoint: string, modelId: string) {
  return {
    ok: true as const,
    account: buildAccount(),
    selectedModel: buildModel(modelId),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    affinityCacheKey: "test-cache-key",
    selectionReason: "affinity_miss" as const,
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

function getLatestRequestLog(): RequestLogSnapshot | null {
  return getAdminDb()
    .query(
      "SELECT initiator, is_subagent, affinity_key_used, affinity_key_source, selection_reason FROM request_log ORDER BY id DESC LIMIT 1;",
    )
    .get() as RequestLogSnapshot | null
}

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM request_log;")

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

describe("messages request log subagent persistence", () => {
  test("writes is_subagent = 1 for __SUBAGENT_MARKER__ requests", async () => {
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

    const stableSessionId = "stable-session-for-subagent-test"

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": stableSessionId,
        },
        body: JSON.stringify(
          createPayload({
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
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    const log = getLatestRequestLog()
    expect(log?.is_subagent).toBe(1)
    expect(log?.affinity_key_used).toBe(stableSessionId)
    expect(log?.affinity_key_source).toBe("x_session_id")
    expect(log?.selection_reason).toBe("affinity_miss")
  })

  test("logs invalid subagent markers with fallback selection reason", async () => {
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

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: '<system-reminder>__SUBAGENT_MARKER__{"session_id":"sub-session"}</system-reminder>',
                  },
                  {
                    type: "text",
                    text: "hello",
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    expect(response.status).toBe(200)
    const latest = getLatestRequestLog()
    expect(latest?.is_subagent).toBe(0)
    expect(latest?.selection_reason).toBe("subagent_marker_invalid_fallback")
  })

  test("keeps tool_result continuations out of is_subagent without marker", async () => {
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

    const response = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          createPayload({
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool_1",
                    content: "ok",
                  },
                ],
              },
            ],
          }),
        ),
      }),
    )

    const latest = getLatestRequestLog()

    expect(response.status).toBe(200)
    expect(latest?.initiator).toBe("agent")
    expect(latest?.is_subagent).toBe(0)
    expect(typeof latest?.affinity_key_used).toBe("string")
    expect(typeof latest?.affinity_key_source).toBe("string")
    expect(latest?.selection_reason).toBe("affinity_miss")
  })
})
