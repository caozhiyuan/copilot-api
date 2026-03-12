import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const isOpencodeOauthApp = (): boolean => {
  return process.env.COPILOT_API_OAUTH_APP === "opencode"
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
  return resolvedDomain ?
      `https://${resolvedDomain}/api/v3`
    : GITHUB_API_BASE_URL
}

export const getOpencodeOauthHeaders = (): Record<string, string> => {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent":
      "opencode/1.2.16 ai-sdk/provider-utils/3.0.21 runtime/bun/1.3.10, opencode/1.2.16",
  }
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

const COPILOT_VERSION = "0.38.2"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = "2025-10-01"

export const copilotBaseUrl = (state: State) => {
  const enterpriseDomain = getEnterpriseDomain()
  if (enterpriseDomain) {
    return `https://copilot-api.${enterpriseDomain}`
  }

  return state.accountType === "individual" ?
      "https://api.githubcopilot.com"
    : `https://api.${state.accountType}.githubcopilot.com`
}

export const copilotHeaders = (
  state: State,
  requestId?: string,
  vision: boolean = false,
) => {
  if (isOpencodeOauthApp()) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${state.copilotToken}`,
      ...getOpencodeOauthHeaders(),
      "Openai-Intent": "conversation-edits",
    }

    if (vision) headers["Copilot-Vision-Request"] = "true"

    return headers
  }

  const requestIdValue = requestId ?? randomUUID()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
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
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
export const OPENCODE_GITHUB_CLIENT_ID = "Ov23li8tweQw6odWQebz"
