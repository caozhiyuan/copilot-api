import { randomUUID } from "node:crypto"

import type { AccountContext } from "./types/account"

import { getCachedOpencodeVersion } from "./opencode"
import { requestContext } from "./request-context"
import { state } from "./state"

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
  isCompact?: boolean,
) => {
  if (isCompact) {
    headers["x-initiator"] = "agent"
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

const OPENCODE_VERSION = "opencode/1.3.15"
const OPENCODE_LLM_USER_AGENT =
  "opencode/1.3.15 ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.11, opencode/1.3.15"

const COPILOT_VERSION = "0.42.3"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const CLAUDE_AGENT_USER_AGENT =
  "vscode_claude_code/2.1.81 (external, sdk-ts, agent-sdk/0.2.81)"

const API_VERSION = "2025-10-01"

export const copilotBaseUrl = (account: AccountContext): string => {
  const enterpriseDomain = getEnterpriseDomain()
  if (enterpriseDomain) {
    return `https://copilot-api.${enterpriseDomain}`
  }

  if (isOpencodeOauthApp()) {
    return "https://api.githubcopilot.com"
  }

  if (account.copilotApiUrl) {
    return account.copilotApiUrl
  }

  return account.accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${account.accountType}.githubcopilot.com`
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
}

export const githubUserHeaders = (
  account: AccountContext,
): Record<string, string> => {
  if (isOpencodeOauthApp()) {
    return {
      Authorization: `Bearer ${account.githubToken}`,
      "User-Agent": getOpencodeVersion(),
    }
  }

  return {
    accept: "application/vnd.github+json",
    authorization: `token ${account.githubToken}`,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}

export const copilotModelsHeaders = (
  account: AccountContext,
): Record<string, string> => {
  if (isOpencodeOauthApp()) {
    const token = account.copilotToken ?? account.githubToken
    return {
      Authorization: `Bearer ${token}`,
      "User-Agent": getOpencodeVersion(),
    }
  }

  return githubCopilotHeaders(account)
}

export const copilotHeaders = (
  account: AccountContext,
  vision: boolean = false,
  requestId?: string,
): Record<string, string> => {
  if (isOpencodeOauthApp()) {
    const token = account.copilotToken ?? account.githubToken
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
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

  return githubCopilotHeaders(account, requestId, vision)
}

const githubCopilotHeaders = (
  account: AccountContext,
  requestId?: string,
  vision: boolean = false,
): Record<string, string> => {
  const resolvedRequestId = requestId ?? randomUUID()
  const resolvedDeviceId = account.clientDeviceId ?? state.vsCodeDeviceId
  const resolvedMachineId = account.clientMachineId ?? state.macMachineId
  const resolvedSessionId = account.clientSessionId ?? state.vsCodeSessionId
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${account.vsCodeVersion}`,
    "editor-device-id": resolvedDeviceId,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-agent",
    "x-github-api-version": API_VERSION,
    "x-request-id": resolvedRequestId,
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-agent-task-id": resolvedRequestId,
    "x-interaction-type": "conversation-agent",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  if (resolvedMachineId) {
    headers["vscode-machineid"] = resolvedMachineId
  }

  if (resolvedSessionId) {
    headers["vscode-sessionid"] = resolvedSessionId
  }

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (account: AccountContext) => {
  if (isOpencodeOauthApp()) {
    return {
      Authorization: `Bearer ${account.githubToken}`,
      ...getOpencodeOauthHeaders(),
    }
  }

  return {
    ...standardHeaders(),
    authorization: `token ${account.githubToken}`,
    "editor-version": `vscode/${account.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "x-github-api-version": API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
export const OPENCODE_GITHUB_CLIENT_ID = "Ov23li8tweQw6odWQebz"
