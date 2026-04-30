import { randomUUID } from "node:crypto"

import { COMPACT_REQUEST, type CompactType } from "~/lib/compact"

import type { State } from "./state"

import { getCachedOpencodeVersion } from "./opencode"
import { requestContext } from "./request-context"

export const isOpencodeOauthApp = (): boolean => {
  return process.env.COPILOT_API_OAUTH_APP?.trim() === "opencode"
}

export const normalizeDomain = (input: string): string => {
  return input
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\/+$/u, "")
}

export const getEnterpriseDomain = (): string | null => {
  const raw = (process.env.COPILOT_API_ENTERPRISE_URL ?? "").trim()
  if (!raw) return null
  const normalized = normalizeDomain(raw)
  return normalized || null
}

export const getGitHubBaseUrl = (): string => {
  const resolvedDomain = getEnterpriseDomain()
  return resolvedDomain ? `https://${resolvedDomain}` : GITHUB_BASE_URL
}

export const getGitHubApiBaseUrl = (): string => {
  const resolvedDomain = getEnterpriseDomain()
  return resolvedDomain ? `https://api.${resolvedDomain}` : GITHUB_API_BASE_URL
}

const getOpencodeOauthHeaders = (): Record<string, string> => {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": getOpencodeVersion(),
  }
}

const getOpencodeLLMHeaders = (): Record<string, string> => {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": OPENCODE_LLM_USER_AGENT,
  }
}

const normalizeOpencodeUserAgent = (userAgent: string): string => {
  const candidate = userAgent.trim()
  const opencodeProduct = candidate.match(/^opencode\/[^\s,]+/u)?.[0]

  if (!opencodeProduct || candidate.includes(`, ${opencodeProduct}`)) {
    return candidate
  }

  return `${candidate}, ${opencodeProduct}`
}

export const getOauthUrls = (): {
  deviceCodeUrl: string
  accessTokenUrl: string
} => {
  const githubBaseUrl = getGitHubBaseUrl()

  return {
    deviceCodeUrl: `${githubBaseUrl}/login/device/code`,
    accessTokenUrl: `${githubBaseUrl}/login/oauth/access_token`,
  }
}

interface OauthAppConfig {
  clientId: string
  headers: Record<string, string>
  scope: string
}

export const getOauthAppConfig = (): OauthAppConfig => {
  if (isOpencodeOauthApp()) {
    return {
      clientId: OPENCODE_GITHUB_CLIENT_ID,
      headers: getOpencodeOauthHeaders(),
      scope: GITHUB_APP_SCOPES,
    }
  }

  return {
    clientId: GITHUB_CLIENT_ID,
    headers: standardHeaders(),
    scope: GITHUB_APP_SCOPES,
  }
}

export const prepareForCompact = (
  headers: Record<string, string>,
  compactType?: CompactType,
) => {
  if (compactType) {
    headers["x-initiator"] = "agent"
    if (!isOpencodeOauthApp() && compactType === COMPACT_REQUEST) {
      headers["x-interaction-type"] = "conversation-other"
      headers["openai-intent"] = "conversation-other"
    }
  }
}

export const prepareInteractionHeaders = (
  sessionId: string | undefined,
  isSubagent: boolean,
  headers: Record<string, string>,
) => {
  const sendInteractionHeaders = !isOpencodeOauthApp()

  if (isSubagent) {
    headers["x-initiator"] = "agent"
    if (sendInteractionHeaders) {
      headers["x-interaction-type"] = "conversation-subagent"
    }
  }

  if (sessionId && sendInteractionHeaders) {
    headers["x-interaction-id"] = sessionId
  }
}

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

export const getOpencodeVersion = () => {
  const version = getCachedOpencodeVersion()
  if (version) {
    return "opencode/" + version
  }
  return OPENCODE_VERSION
}

const OPENCODE_VERSION = "opencode/1.14.29"
const OPENCODE_LLM_USER_AGENT =
  "opencode/1.14.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13, opencode/1.14.29"

const COPILOT_VERSION = "0.46.0"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const CLAUDE_AGENT_USER_AGENT =
  "vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)"

const API_VERSION = "2025-10-01"

export const copilotBaseUrl = (state: State) => {
  const enterpriseDomain = getEnterpriseDomain()
  if (enterpriseDomain) {
    return `https://copilot-api.${enterpriseDomain}`
  }

  if (isOpencodeOauthApp()) {
    return "https://api.githubcopilot.com"
  }

  if (state.copilotApiUrl) {
    return state.copilotApiUrl
  }

  return state.accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${state.accountType}.githubcopilot.com`
}

export const prepareMessageProxyHeaders = (headers: Record<string, string>) => {
  if (isOpencodeOauthApp()) {
    return
  }

  // vscode copilot claude agent regenerates request id for
  // each request, keeping it consistent
  const requestIdValue = randomUUID()
  headers["x-agent-task-id"] = requestIdValue
  headers["x-request-id"] = requestIdValue

  // Consistent with vscode copilot claude agent
  headers["x-interaction-type"] = "messages-proxy"
  headers["openai-intent"] = "messages-proxy"
  headers["user-agent"] = CLAUDE_AGENT_USER_AGENT

  delete headers["copilot-integration-id"]
}

export const githubUserHeaders = (state: State): Record<string, string> => {
  if (isOpencodeOauthApp()) {
    return {
      Authorization: `Bearer ${state.githubToken}`,
      "User-Agent": getOpencodeVersion(),
    }
  }
  return {
    accept: "application/vnd.github+json",
    authorization: `token ${state.githubToken}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}

export const copilotModelsHeaders = (state: State) => {
  if (isOpencodeOauthApp()) {
    return {
      Authorization: `Bearer ${state.copilotToken}`,
      "User-Agent": getOpencodeVersion(),
    }
  }
  const headers = githubCopilotHeaders(state)
  headers["x-interaction-type"] = "model-access"
  headers["openai-intent"] = "model-access"
  delete headers["x-interaction-id"]
  delete headers["content-type"]
  return headers
}

export const copilotHeaders = (
  state: State,
  requestId?: string,
  vision: boolean = false,
) => {
  if (isOpencodeOauthApp()) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${state.copilotToken}`,
      ...getOpencodeLLMHeaders(),
      "Openai-Intent": "conversation-edits",
    }

    const store = requestContext.getStore()
    const userAgent = store?.userAgent.trim()
    // Real opencode traffic already carries a versioned opencode/* UA,
    // so prefer the inbound header to keep upstream behavior aligned.
    if (userAgent?.startsWith("opencode/")) {
      headers["User-Agent"] = normalizeOpencodeUserAgent(userAgent)
    }

    if (store?.sessionAffinity) {
      headers["x-session-affinity"] = store.sessionAffinity
    }

    if (store?.parentSessionId) {
      headers["x-parent-session-id"] = store.parentSessionId
    }

    if (vision) headers["Copilot-Vision-Request"] = "true"

    return headers
  }

  return githubCopilotHeaders(state, requestId, vision)
}

const githubCopilotHeaders = (
  state: State,
  requestId?: string,
  vision: boolean = false,
) => {
  const requestIdValue = requestId ?? randomUUID()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-device-id": state.vsCodeDeviceId,
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-github-api-version": API_VERSION,
    "x-request-id": requestIdValue,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-agent-task-id": requestIdValue,
    "x-interaction-type": "conversation-agent",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  if (state.macMachineId) {
    headers["vscode-machineid"] = state.macMachineId
  }

  if (state.vsCodeSessionId) {
    headers["vscode-sessionid"] = state.vsCodeSessionId
  }

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State): Record<string, string> => {
  if (isOpencodeOauthApp()) {
    return {
      Authorization: `Bearer ${state.githubToken}`,
      ...getOpencodeOauthHeaders(),
    }
  }
  return {
    authorization: `token ${state.githubToken}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2025-04-01",
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
export const OPENCODE_GITHUB_CLIENT_ID = "Ov23li8tweQw6odWQebz"
