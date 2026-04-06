import { afterEach, describe, expect, test } from "bun:test"

import type { AccountContext } from "../src/lib/types/account"

import {
  copilotBaseUrl,
  copilotHeaders,
  copilotModelsHeaders,
  githubHeaders,
  githubUserHeaders,
  prepareMessageProxyHeaders,
} from "../src/lib/api-config"
import { requestContext } from "../src/lib/request-context"
import { state } from "../src/lib/state"

const initialOauthApp = process.env.COPILOT_API_OAUTH_APP
const initialEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL

const accountContext: AccountContext = {
  githubToken: "ghu_test",
  copilotToken: "copilot_test",
  accountType: "business",
  vsCodeVersion: "1.0.0",
}

afterEach(() => {
  if (initialOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = initialOauthApp
  }

  if (initialEnterpriseUrl === undefined) {
    delete process.env.COPILOT_API_ENTERPRISE_URL
  } else {
    process.env.COPILOT_API_ENTERPRISE_URL = initialEnterpriseUrl
  }
})

describe("copilotBaseUrl", () => {
  test("uses the account-specific Copilot endpoint when present", () => {
    delete process.env.COPILOT_API_OAUTH_APP
    delete process.env.COPILOT_API_ENTERPRISE_URL

    expect(
      copilotBaseUrl({
        ...accountContext,
        copilotApiUrl: "https://copilot-proxy.example.com",
      }),
    ).toBe("https://copilot-proxy.example.com")
  })

  test("prefers enterprise routing over the account-specific Copilot endpoint", () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "ghe.example.com"

    expect(
      copilotBaseUrl({
        ...accountContext,
        copilotApiUrl: "https://copilot-proxy.example.com",
      }),
    ).toBe("https://copilot-api.ghe.example.com")
  })

  test("keeps opencode on the public Copilot endpoint", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    expect(
      copilotBaseUrl({
        ...accountContext,
        copilotApiUrl: "https://copilot-proxy.example.com",
      }),
    ).toBe("https://api.githubcopilot.com")
  })
})

test("githubHeaders uses opencode bearer auth when configured", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = githubHeaders(accountContext) as Record<string, string>

  expect(headers.Authorization).toBe("Bearer ghu_test")
  expect(headers["User-Agent"]).toContain("opencode/")
})

test("githubUserHeaders uses opencode bearer auth and versioned user-agent", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = githubUserHeaders(accountContext)

  expect(headers.Authorization).toBe("Bearer ghu_test")
  expect(headers["User-Agent"]).toContain("opencode/")
})

test("copilotHeaders prefers account-scoped identity values over global state", () => {
  delete process.env.COPILOT_API_OAUTH_APP

  state.vsCodeDeviceId = "global-device-id"
  state.macMachineId =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  state.vsCodeSessionId = "global-session-id"

  const headers = copilotHeaders({
    ...accountContext,
    clientDeviceId: "11111111-1111-4111-8111-111111111111",
    clientMachineId:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientSessionId: "11111111-1111-4111-8111-1111111111111712345678901",
  })

  expect(headers["editor-device-id"]).toBe(
    "11111111-1111-4111-8111-111111111111",
  )
  expect(headers["vscode-machineid"]).toBe(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  )
  expect(headers["vscode-sessionid"]).toBe(
    "11111111-1111-4111-8111-1111111111111712345678901",
  )
})

test("copilot headers keep opencode model discovery and llm user-agents separate", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const modelHeaders = copilotModelsHeaders(accountContext)
  const llmHeaders = copilotHeaders(accountContext)

  expect(modelHeaders.Authorization).toBe("Bearer copilot_test")
  expect(modelHeaders["User-Agent"]).toMatch(/^opencode\//)
  expect(llmHeaders["User-Agent"]).toContain("ai-sdk/provider-utils")
})

test("copilotHeaders forwards opencode session affinity metadata from request context", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"
  const inboundUserAgent =
    "opencode/9.9.9 ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.11, opencode/9.9.9"

  const headers = requestContext.run(
    {
      traceId: "trace-1",
      startTime: Date.now(),
      userAgent: inboundUserAgent,
      sessionAffinity: "affinity-1",
      parentSessionId: "parent-1",
    },
    () => copilotHeaders(accountContext),
  )

  expect(headers.Authorization).toBe("Bearer copilot_test")
  expect(headers["User-Agent"]).toBe(inboundUserAgent)
  expect(headers["x-session-affinity"]).toBe("affinity-1")
  expect(headers["x-parent-session-id"]).toBe("parent-1")
})

test("prepareMessageProxyHeaders applies message proxy headers by default", () => {
  delete process.env.COPILOT_API_OAUTH_APP

  const headers: Record<string, string> = {
    "user-agent": "GitHubCopilotChat/0.42.3",
  }

  prepareMessageProxyHeaders(headers)

  expect(headers["x-interaction-type"]).toBe("messages-proxy")
  expect(headers["openai-intent"]).toBe("messages-proxy")
  expect(headers["user-agent"]).toBe(
    "vscode_claude_code/2.1.81 (external, sdk-ts, agent-sdk/0.2.81)",
  )
  expect(headers["x-request-id"]).toBeDefined()
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
})

test("prepareMessageProxyHeaders leaves opencode headers untouched", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers: Record<string, string> = {
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  }

  prepareMessageProxyHeaders(headers)

  expect(headers).toEqual({
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  })
})
