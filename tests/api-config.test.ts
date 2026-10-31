import { afterEach, beforeEach, expect, test } from "bun:test"

import type { State } from "~/lib/state"

import {
  copilotHeaders,
  githubHeaders,
  githubUserHeaders,
  prepareForCompact,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { COMPACT_AUTO_CONTINUE, COMPACT_REQUEST } from "~/lib/compact"
import { isAlphaSearchCodexPriorityEnabled } from "~/lib/config"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import { getVSCodeVersion } from "~/services/get-vscode-version"

const originalOauthApp = process.env.COPILOT_API_OAUTH_APP
const originalEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL
const proxyState: State = {
  accountType: "individual",
  copilotApiUrl: "https://api.individual.githubcopilot.com",
  githubToken: "test-github-token",
  copilotToken: "test-copilot-token",
  vsCodeVersion: "1.144.0",
  vsCodeDeviceId: "device-1",
  vsCodeSessionId: "session-1",
  macMachineId: "machine-1",
  showToken: false,
  verbose: false,
}

beforeEach(() => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL
})

afterEach(() => {
  if (originalEnterpriseUrl === undefined) {
    delete process.env.COPILOT_API_ENTERPRISE_URL
  } else {
    process.env.COPILOT_API_ENTERPRISE_URL = originalEnterpriseUrl
  }
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
    return
  }

  process.env.COPILOT_API_OAUTH_APP = originalOauthApp
})

test("prepareMessageProxyHeaders uses the captured casing and GitHub credentials", () => {
  const headers: Record<string, string> = {
    ...copilotHeaders(proxyState, "original-request-id", true),
    "anthropic-version": "client-version",
    "anthropic-beta": "context-management-2025-06-27",
    "x-initiator": "user",
    "x-interaction-id": "interaction-1",
  }

  prepareMessageProxyHeaders(headers, proxyState)

  const requestId = headers["X-Request-Id"]
  expect(requestId).toMatch(
    /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u,
  )
  expect(headers).toEqual({
    "anthropic-version": "client-version",
    "anthropic-beta": "context-management-2025-06-27",
    "User-Agent":
      "vscode_claude_code/2.1.304 (external, sdk-ts, agent-sdk/0.3.304)",
    "Content-Type": "application/json",
    Authorization: "Bearer test-github-token",
    "X-Request-Id": requestId,
    "X-GitHub-Api-Version": "2026-08-01",
    "OpenAI-Intent": "messages-proxy",
    "X-Interaction-Type": "messages-proxy",
    "VScode-SessionId": "session-1",
    "VScode-MachineId": "machine-1",
    "Editor-Device-Id": "device-1",
    "Editor-Plugin-Version": "copilot-chat/1.144.0",
    "Editor-Version": "vscode/1.144.0",
  })
  expect(headers["X-Request-Id"]).not.toBe("original-request-id")
})

test("Copilot requests use the upgraded VS Code and Copilot Chat versions", async () => {
  const vsCodeVersion = await getVSCodeVersion()
  const headers = copilotHeaders({ ...proxyState, vsCodeVersion })

  expect(headers["editor-version"]).toBe("vscode/1.144.0")
  expect(headers["editor-plugin-version"]).toBe("copilot-chat/0.72.0")
  expect(headers["user-agent"]).toBe("GitHubCopilotChat/0.72.0")
  expect(githubHeaders(proxyState)["user-agent"]).toBe(
    "GitHubCopilotChat/0.72.0",
  )
  expect(githubUserHeaders(proxyState)["user-agent"]).toBe(
    "GitHubCopilotChat/0.72.0",
  )
})

test("reads the alpha search Codex priority setting", () => {
  expect(typeof isAlphaSearchCodexPriorityEnabled()).toBe("boolean")
})

test("prepareMessageProxyHeaders leaves opencode headers untouched", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers: Record<string, string> = {
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  }

  prepareMessageProxyHeaders(headers, proxyState)

  expect(headers).toEqual({
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  })
})

test.each([
  ["opencode/latest/2.0.18/cli", "opencode/latest/2.0.18/cli"],
  ["  opencode/latest/2.0.18/cli  ", "opencode/latest/2.0.18/cli"],
  ["opencode/latest/2.0.18/desktop", "opencode/latest/2.0.18/desktop"],
  ["opencode/latest", "opencode/latest"],
  ["opencode/1.18.32", "opencode/1.18.32, opencode/1.18.32"],
  ["opencode/1.18.32, opencode/1.18.32", "opencode/1.18.32, opencode/1.18.32"],
])("copilotHeaders normalizes UA %s to %s", (userAgent, expected) => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = requestContext.run(
    {
      traceId: "test-trace",
      startTime: Date.now(),
      userAgent,
      sessionAffinity: "child-session",
      parentSessionId: "parent-session",
    },
    () => copilotHeaders(state),
  )

  expect(headers["User-Agent"]).toBe(expected)
  expect(headers["x-session-affinity"]).toBe("child-session")
  expect(headers["x-parent-session-id"]).toBe("parent-session")
})

test("prepareForCompact marks compact traffic as agent initiated", () => {
  const compactHeaders: Record<string, string> = { "x-initiator": "user" }
  const autoContinueHeaders: Record<string, string> = { "x-initiator": "user" }
  const normalHeaders: Record<string, string> = { "x-initiator": "user" }

  prepareForCompact(compactHeaders, COMPACT_REQUEST)
  prepareForCompact(autoContinueHeaders, COMPACT_AUTO_CONTINUE)
  prepareForCompact(normalHeaders, 0)

  expect(compactHeaders["x-initiator"]).toBe("agent")
  expect(autoContinueHeaders["x-initiator"]).toBe("agent")
  expect(normalHeaders["x-initiator"]).toBe("user")
})
