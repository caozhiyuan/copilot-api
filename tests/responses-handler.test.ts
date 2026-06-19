import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { createResponses as createCopilotResponses } from "../src/services/copilot/create-responses"

let responsesApiWebSocketEnabled = true

const createResponses = mock((() =>
  Promise.resolve(streamChunks([]))) as typeof createCopilotResponses)

const createResponsesResult = (model: string) => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response" as const,
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const { state } = await import("../src/lib/state")
const { closeUsageStore } = await import("../src/lib/token-usage")
const { tokenUsageRoute } = await import("../src/routes/token-usage/route")
const { responsesHandlerDependencies } = await import(
  "../src/routes/responses/handler"
)
const { responsesRoutes } = await import("../src/routes/responses/route")
const { responsesUtilsDependencies } = await import(
  "../src/routes/responses/utils"
)
const { generateRequestIdFromPayload, getUUID } = await import(
  "../src/lib/utils"
)

const defaultResponsesHandlerDependencies = {
  ...responsesHandlerDependencies,
}
const defaultResponsesUtilsDependencies = { ...responsesUtilsDependencies }

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  macMachineId: state.macMachineId,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()

  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.macMachineId = "machine-1"
  state.manualApprove = false
  state.verbose = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {
            max_prompt_tokens: 128000,
          },
        },
        id: "gpt-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  responsesApiWebSocketEnabled = true
  responsesHandlerDependencies.checkRateLimit = async () => {}
  responsesHandlerDependencies.createResponses = createResponses
  responsesHandlerDependencies.isResponsesApiWebSearchEnabled = () => true
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isResponsesApiContextManagementEnabled = () => true
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createResponses.mockReset()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)

  state.copilotToken = originalState.copilotToken
  state.accountType = originalState.accountType
  state.macMachineId = originalState.macMachineId
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.rateLimitWait = originalState.rateLimitWait
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  state.models = originalState.models
  Object.assign(
    responsesHandlerDependencies,
    defaultResponsesHandlerDependencies,
  )
  Object.assign(responsesUtilsDependencies, defaultResponsesUtilsDependencies)
})

describe("responses handler token usage", () => {
  test("uses websocket transport by default for dual-endpoint models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("websocket")
    expect(createResponses.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponses.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    responsesApiWebSocketEnabled = false
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
  })

  test("keeps HTTP transport when the selected model only supports /responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.transport).toBe("http")
  })

  test("uses model Responses API compact threshold before max token fallback", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-threshold-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    responsesUtilsDependencies.getModelResponsesApiCompactThreshold = (
      model,
    ) => (model === "gpt-threshold-test" ? 272_000 * 0.8 : undefined)
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-threshold-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 217600,
      },
    ])
  })

  test("does not add context management when input ends with compaction trigger", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              {
                text: "Completed the review for the latest two commits.",
                type: "output_text",
              },
            ],
            phase: "final_answer",
            role: "assistant",
            type: "message",
          },
          {
            type: "compaction_trigger",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].context_management).toBeUndefined()
  })

  test("preserves custom apply_patch tools for Copilot Responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )
    const applyPatchTool = {
      type: "custom",
      name: "apply_patch",
      description: "Edit files with a patch",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
        tools: [applyPatchTool],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].tools?.[0]).toEqual(applyPatchTool)
  })

  test("uses Codex subagent headers for Responses request attribution", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "child-thread",
      agent_type: "collab_spawn",
      session_id: "child-thread",
    })
  })

  test("does not use Codex parent thread header as Responses session", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "SUBAGENT_PROBE", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "x-codex-parent-thread-id": "parent-thread",
        "x-openai-subagent": "collab_spawn",
        "x-session-id": "alternate-session",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    expect(options?.initiator).toBe("agent")
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.requestId).toBe(
      generateRequestIdFromPayload(
        { messages: payload.input },
        expectedSessionId,
      ),
    )
    expect(options?.subagentMarker).toEqual({
      agent_id: "parent-thread",
      agent_type: "collab_spawn",
      session_id: "root-session",
    })
  })

  test("uses session headers when Codex subagent header is missing", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)

    const options = createResponses.mock.calls[0][1]
    const expectedSessionId = getUUID("root-session")
    const expectedRequestId = generateRequestIdFromPayload(
      { messages: payload.input },
      expectedSessionId,
    )
    expect(options?.initiator).toBe("user")
    expect(options?.requestId).toBe(expectedRequestId)
    expect(options?.sessionId).toBe(expectedSessionId)
    expect(options?.subagentMarker).toBeNull()
  })

  test("ignores unknown x-openai-subagent values", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const payload = {
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      model: "gpt-test",
    }

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "session-id": "root-session",
        "thread-id": "child-thread",
        "x-openai-subagent": "unexpected",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1]?.initiator).toBe("user")
    expect(createResponses.mock.calls[0][1]?.subagentMarker).toBeNull()
  })

  test("accepts known Codex subagent header values", async () => {
    for (const agentType of ["compact", "memory_consolidation", "review"]) {
      createResponses.mockReset()
      createResponses.mockImplementation((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

      const app = createApp()
      const response = await app.request("/v1/responses", {
        body: JSON.stringify({
          input: [
            {
              content: [{ text: "hello", type: "input_text" }],
              role: "user",
            },
          ],
          model: "gpt-test",
        }),
        headers: {
          "content-type": "application/json",
          "session-id": "root-session",
          "thread-id": "child-thread",
          "x-openai-subagent": agentType,
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(createResponses).toHaveBeenCalledTimes(1)
      expect(createResponses.mock.calls[0][1]?.initiator).toBe("agent")
      expect(createResponses.mock.calls[0][1]?.subagentMarker).toEqual({
        agent_id: "child-thread",
        agent_type: agentType,
        session_id: "child-thread",
      })
    }
  })

  test("omits oversized input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 8,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                image_url: `data:image/png;base64,${"A".repeat(16)}`,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    const image = (
      createResponses.mock.calls[0][0].input as Array<{
        content: Array<{
          detail?: string
          image_url?: string
          text?: string
          type: string
        }>
      }>
    )[0].content[1]
    expect(image.type).toBe("input_image")
    expect(image.detail).toBe("low")
    expect(image.image_url?.startsWith("data:image/png;base64,")).toBe(true)
    expect(image.text).toBeUndefined()
  })

  test("preserves multiple input images before forwarding to Copilot Responses", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 1024,
                max_prompt_images: 1,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const firstImageUrl = `data:image/png;base64,${"A".repeat(8)}`
    const secondImageUrl = `data:image/png;base64,${"B".repeat(8)}`

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              {
                detail: "low",
                image_url: firstImageUrl,
                type: "input_image",
              },
              {
                detail: "low",
                image_url: secondImageUrl,
                type: "input_image",
              },
            ],
            role: "user",
          },
        ],
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][0].input).toEqual([
      {
        content: [
          { text: "look", type: "input_text" },
          { detail: "low", image_url: firstImageUrl, type: "input_image" },
          { detail: "low", image_url: secondImageUrl, type: "input_image" },
        ],
        role: "user",
      },
    ])
  })

  test("records usage from failed streaming responses and falls back to interaction id", async () => {
    createResponses.mockImplementation(() =>
      Promise.resolve(
        streamChunks([
          {
            data: JSON.stringify({
              response: {
                created_at: 0,
                error: {
                  message: "request failed",
                },
                id: "resp_123",
                incomplete_details: null,
                instructions: null,
                metadata: null,
                model: "gpt-test",
                object: "response",
                output: [],
                output_text: "",
                parallel_tool_calls: false,
                status: "failed",
                temperature: null,
                tool_choice: "auto",
                tools: [],
                top_p: null,
                copilot_usage: {
                  total_nano_aiu: 1234,
                },
                usage: {
                  input_tokens: 5,
                  input_tokens_details: {
                    cached_tokens: 1,
                  },
                  output_tokens: 2,
                  total_tokens: 7,
                },
              },
              sequence_number: 1,
              type: "response.failed",
            }),
            event: "response.failed",
            id: "event_1",
          },
        ]),
      ),
    )

    const app = createApp()
    const payload = {
      input: "hello",
      model: "gpt-test",
      stream: true,
    }

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    expect(response.status).toBe(200)
    await response.text()

    const eventsResponse = await app.request(
      "/token-usage/events?period=day&page=1&page_size=10",
    )
    expect(eventsResponse.status).toBe(200)

    const page = (await eventsResponse.json()) as {
      items: Array<{
        cache_read_input_tokens: number
        input_tokens: number
        output_tokens: number
        session_id: string
        total_nano_aiu: number | null
        total_tokens: number
      }>
    }
    expect(page.items).toHaveLength(1)

    const expectedRequestId = generateRequestIdFromPayload({
      messages: payload.input,
    })
    const expectedInteractionId = getUUID(expectedRequestId)

    expect(page.items[0]?.session_id).toBe(expectedInteractionId)
    expect(page.items[0]?.cache_read_input_tokens).toBe(1)
    expect(page.items[0]?.input_tokens).toBe(4)
    expect(page.items[0]?.output_tokens).toBe(2)
    expect(page.items[0]?.total_nano_aiu).toBe(1234)
    expect(page.items[0]?.total_tokens).toBe(7)
  })
})
