import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type {
  ResponsesPayload,
  ResponsesResult,
} from "../src/services/copilot/create-responses"

import {
  copilotHeaders,
  copilotWebSocketHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "../src/lib/api-config"
import { COMPACT_REQUEST } from "../src/lib/compact"
import { state } from "../src/lib/state"
import {
  buildResponsesWebSocketPoolKey,
  buildResponsesWebSocketPayload,
  buildResponsesWebSocketUrl,
  createResponses,
  prepareResponsesWebSocketRequest,
} from "../src/services/copilot/create-responses"

const originalFetch = globalThis.fetch
const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}

const createResponsesResult = (model: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response",
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

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(JSON.stringify(createResponsesResult("gpt-test")), {
      headers: {
        "content-type": "application/json",
      },
      status: 200,
    }),
  ),
)

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  state.accountType = "individual"
  state.copilotToken = "test-token"
  state.macMachineId = "machine-1"
  state.vsCodeDeviceId = "device-1"
  state.vsCodeSessionId = "session-1"
  state.vsCodeVersion = "1.120.0"

  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = originalOauthApp
  }

  state.accountType = originalState.accountType
  state.copilotToken = originalState.copilotToken
  state.macMachineId = originalState.macMachineId
  state.vsCodeDeviceId = originalState.vsCodeDeviceId
  state.vsCodeSessionId = originalState.vsCodeSessionId
  state.vsCodeVersion = originalState.vsCodeVersion
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

describe("createResponses", () => {
  test("keeps HTTP responses requests using x-initiator header", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const requestInit = init as RequestInit & {
      headers: Record<string, string>
    }
    expect(requestInit.headers["x-initiator"]).toBe("user")
    expect(requestInit.headers["X-Request-Id"]).toBeUndefined()

    expect(typeof requestInit.body).toBe("string")
    const body = JSON.parse(requestInit.body as string) as Record<
      string,
      unknown
    >
    expect(body.initiator).toBeUndefined()
    expect(body.type).toBeUndefined()
  })

  test("sets subagent interaction headers for HTTP responses requests", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }

    await createResponses(payload, {
      initiator: "agent",
      requestId: "request-1",
      sessionId: "interaction-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "collab_spawn",
        session_id: "sub-session",
      },
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    const requestInit = init as RequestInit & {
      headers: Record<string, string>
    }
    expect(requestInit.headers["x-initiator"]).toBe("agent")
    expect(requestInit.headers["x-interaction-id"]).toBe("interaction-1")
    expect(requestInit.headers["x-interaction-type"]).toBe(
      "conversation-subagent",
    )
  })

  test("uses HTTP when websocket transport is requested without stream=true", async () => {
    const payload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
      stream: false,
    }

    const response = await createResponses(payload, {
      initiator: "user",
      requestId: "request-1",
      transport: "websocket",
      vision: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(response).toEqual(createResponsesResult("gpt-test"))
  })

  test("builds the first websocket frame as response.create", () => {
    const payload = {
      background: true,
      input: "hello",
      model: "gpt-test",
      service_tier: "auto",
      stream: true,
    } as ResponsesPayload

    const websocketPayload = buildResponsesWebSocketPayload(payload, "agent")

    expect(websocketPayload).toEqual({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect("stream" in websocketPayload).toBe(false)
    expect("background" in websocketPayload).toBe(false)
    expect("service_tier" in websocketPayload).toBe(false)
  })

  test("builds websocket URLs from the Copilot base URL", () => {
    expect(buildResponsesWebSocketUrl("https://api.githubcopilot.com")).toBe(
      "wss://api.githubcopilot.com/responses",
    )
    expect(buildResponsesWebSocketUrl("http://localhost:3000/")).toBe(
      "ws://localhost:3000/responses",
    )
  })

  test("builds capture-style websocket headers without x-initiator", () => {
    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", true),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", false, preparedHeaders)

    const headers = copilotWebSocketHeaders(preparedHeaders)

    expect(headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Device-Id": "device-1",
      "Editor-Plugin-Version": "copilot-chat/0.50.1",
      "Editor-Version": "vscode/1.120.0",
      "OpenAI-Intent": "conversation-agent",
      "VScode-SessionId": "session-1",
      "VScode-MachineId": "machine-1",
      "X-Agent-Task-Id": "request-1",
      "X-GitHub-Api-Version": "2026-01-09",
      "X-Interaction-Id": "interaction-1",
      "X-Interaction-Type": "conversation-agent",
      "X-Request-Id": "request-1",
      "user-agent": "node",
    })
    const headerNames = Object.keys(headers)
    const agentTaskIdIndex = headerNames.indexOf("X-Agent-Task-Id")
    expect(
      headerNames.slice(agentTaskIdIndex + 1, agentTaskIdIndex + 3),
    ).toEqual(["VScode-SessionId", "VScode-MachineId"])
    expect(headerNames[headerNames.length - 1]).toBe("user-agent")
    expect(headers.accept).toBeUndefined()
    expect(headers["accept-encoding"]).toBeUndefined()
    expect(headers["accept-language"]).toBeUndefined()
    expect(headers["cache-control"]).toBeUndefined()
    expect(headers.pragma).toBeUndefined()
    expect(headers["sec-fetch-mode"]).toBeUndefined()
    expect(headers["x-initiator"]).toBeUndefined()
    expect(headers["sec-websocket-key"]).toBeUndefined()
  })

  test("websocket request uses prepared compact and interaction headers", () => {
    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", false),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
        subagentMarker: {
          agent_id: "agent-1",
          agent_type: "Explore",
          session_id: "sub-session",
        },
      },
    )

    expect(request.payload).toMatchObject({
      initiator: "agent",
      input: "hello",
      model: "gpt-test",
      type: "response.create",
    })
    expect(request.headers["OpenAI-Intent"]).toBe("conversation-agent")
    expect(request.headers["X-Interaction-Id"]).toBe("interaction-1")
    expect(request.headers["X-Interaction-Type"]).toBe(
      "conversation-compaction",
    )
    expect(request.headers["x-initiator"]).toBeUndefined()
  })

  test("websocket request keeps opencode headers and moves x-initiator into body", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    const preparedHeaders = {
      ...copilotHeaders(state, "request-1", false),
      "x-initiator": "user",
    }
    prepareInteractionHeaders("interaction-1", true, preparedHeaders)
    prepareForCompact(preparedHeaders, COMPACT_REQUEST)

    const request = prepareResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-test",
        stream: true,
      },
      preparedHeaders,
      {
        requestId: "request-1",
      },
    )

    expect(request.payload.initiator).toBe("agent")
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Openai-Intent": "conversation-edits",
    })
    expect(request.headers["User-Agent"]).toStartWith("opencode/")
    expect(request.headers["x-initiator"]).toBeUndefined()
    expect(request.headers["X-Request-Id"]).toBeUndefined()
    expect(request.headers["x-interaction-id"]).toBeUndefined()
  })

  test("websocket pool key separates model request and subagent context", () => {
    const basePayload: ResponsesPayload = {
      input: "hello",
      model: "gpt-test",
    }
    const mainKey = buildResponsesWebSocketPoolKey(basePayload, {
      requestId: "request-1",
    })
    const subagentKey = buildResponsesWebSocketPoolKey(basePayload, {
      requestId: "request-1",
      subagentMarker: {
        agent_id: "agent-1",
        agent_type: "Explore",
        session_id: "sub-session",
      },
    })
    const otherModelKey = buildResponsesWebSocketPoolKey(
      {
        ...basePayload,
        model: "gpt-other",
      },
      {
        requestId: "request-1",
      },
    )

    expect(new Set([mainKey, subagentKey, otherModelKey]).size).toBe(3)
    expect(mainKey).toContain("gpt-test")
    expect(mainKey).toContain("request-1")
  })
})
