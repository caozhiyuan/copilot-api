import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { createResponses as createCopilotResponses } from "../src/services/copilot/create-responses"
import { HTTPError } from "../src/lib/error"

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

const createPayloadTooLargeError = () =>
  new HTTPError(
    "Failed to create responses",
    new Response(
      JSON.stringify({
        error: { code: "", message: "failed to parse request" },
      }),
      { status: 413 },
    ),
  )

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
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
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
  state.manualApprove = false
  state.verbose = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
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
  responsesUtilsDependencies.isResponsesApiWebSocketEnabled = () =>
    responsesApiWebSocketEnabled
  createResponses.mockReset()
})

afterEach(async () => {
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)

  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.rateLimitWait = originalState.rateLimitWait
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
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
    expect(createResponses.mock.calls[0][0].input).toEqual([
      {
        content: [
          { text: "look", type: "input_text" },
          {
            text: "[omitted input image: image/png, 12 bytes, max 8 bytes]",
            type: "input_text",
          },
        ],
        role: "user",
      },
    ])
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

  test("retries once without remaining input images after Copilot rejects payload as too large", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
              vision: {
                max_prompt_image_size: 1024,
                max_prompt_images: 10,
              },
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses"],
        },
      ],
    } as typeof state.models
    createResponses
      .mockImplementationOnce(() =>
        Promise.reject(createPayloadTooLargeError()),
      )
      .mockImplementationOnce((payload) =>
        Promise.resolve(createResponsesResult(payload.model)),
      )

    const app = createApp()
    const imageUrl = `data:image/png;base64,${"A".repeat(8)}`
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: [
          {
            content: [
              { text: "look", type: "input_text" },
              { detail: "low", image_url: imageUrl, type: "input_image" },
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
    expect(createResponses).toHaveBeenCalledTimes(2)
    expect(createResponses.mock.calls[1][0].input).toEqual([
      {
        content: [
          { text: "look", type: "input_text" },
          {
            text: "[omitted input image: image/png, 6 bytes, upstream rejected payload as too large]",
            type: "input_text",
          },
        ],
        role: "user",
      },
    ])
    expect(createResponses.mock.calls[1][1]?.vision).toBe(false)
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
    expect(page.items[0]?.total_tokens).toBe(7)
  })
})
